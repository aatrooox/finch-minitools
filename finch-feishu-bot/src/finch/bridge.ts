import type * as finch from 'finch';
import type { FeishuManager, CardSessionHandle } from '../feishu/manager.js';
import type { InboundMessageContext, CardActionContext } from '../types.js';

interface StreamState {
  chatId: string;
  cardHandle: CardSessionHandle | null;
  textBuffer: string;
  lastPatchTime: number;
  patchTimer: NodeJS.Timeout | null;
}

interface PendingConfirmation {
  actionId: string;
  chatId: string;
  title: string;
  content: string;
  resolve: (decision: 'yes' | 'no') => void;
}

const STORAGE_SESSION_PREFIX = 'feishu:session:';

export class BridgeManager {
  // 保存活跃 Turn 的流式输出状态: key 为 turnId
  private activeStreams = new Map<string, StreamState>();
  // 会话映射：chatId -> sessionId 内存缓存
  private chatSessions = new Map<string, string>();
  // 等待用户点击确认的卡片：actionId -> PendingConfirmation
  private pendingConfirmations = new Map<string, PendingConfirmation>();

  constructor(
    private readonly ctx: finch.MiniToolContext,
    private readonly feishu: FeishuManager
  ) {
    this.setupEventListeners();
    this.setupCardActionListeners();
  }

  /**
   * 获取或复用与 chatId 绑定的 Finch Session
   */
  private async getOrCreateSession(msg: InboundMessageContext): Promise<string> {
    // 1. 先从内存 Map 查找
    let sessionId = this.chatSessions.get(msg.chatId);
    if (sessionId) {
      // 验证 Session 是否仍然有效存在
      const existing = await this.ctx.sessions.get(sessionId);
      if (existing) {
        return sessionId;
      }
    }

    // 2. 从 ctx.storage 持久化层读取（解决小程序更新/重载后丢失会话的问题）
    const storageKey = `${STORAGE_SESSION_PREFIX}${msg.chatId}`;
    const persistedSessionId = await this.ctx.storage.get<string>(storageKey);
    if (persistedSessionId) {
      const existing = await this.ctx.sessions.get(persistedSessionId);
      if (existing) {
        this.chatSessions.set(msg.chatId, persistedSessionId);
        return persistedSessionId;
      }
    }

    // 3. 不存在或已被销毁，在 feishu 容器内创建新 Session
    const title = msg.chatType === 'group' ? `群聊: ${msg.chatId.slice(-6)}` : `用户: ${msg.senderId.slice(-6)}`;
    const sessionInfo = await this.ctx.sessions.create({
      containerId: 'feishu',
      title,
      activity: 'interactive',
      permissionMode: 'acceptCalls'
    });

    sessionId = sessionInfo.sessionId;
    this.chatSessions.set(msg.chatId, sessionId);
    await this.ctx.storage.set(storageKey, sessionId);
    return sessionId;
  }

  /**
   * 处理从飞书收到的消息并转入 Finch Session
   */
  public async handleInboundMessage(msg: InboundMessageContext): Promise<void> {
    const isAutoReply = this.ctx.settings.get<boolean>('autoReply') ?? true;

    try {
      const sessionId = await this.getOrCreateSession(msg);

      let cardHandle: CardSessionHandle | null = null;
      if (isAutoReply) {
        // 创建飞书原生流式卡片
        cardHandle = await this.feishu.createStreamingCard(msg.chatId);
      }

      // 将用户消息投递到 Finch 会话
      const receipt = await this.ctx.sessions.send(sessionId, {
        text: msg.text,
        idempotencyKey: `feishu_${msg.messageId}`
      });

      if (receipt.state === 'rejected') {
        this.ctx.logger.warn('Failed to send to session: queue full', receipt);
        return;
      }

      if (isAutoReply) {
        this.activeStreams.set(receipt.turnId, {
          chatId: msg.chatId,
          cardHandle,
          textBuffer: '',
          lastPatchTime: Date.now(),
          patchTimer: null
        });
      }
    } catch (err) {
      this.ctx.logger.error('Failed to handle inbound message into Finch session:', err);
    }
  }

  /**
   * 向飞书发送授权/操作确认卡片（带 Yes/No 按钮），并返回一个 Promise 等待用户点击决策
   */
  public async askConfirmation(params: {
    chatId: string;
    title: string;
    content: string;
    yesLabel?: string;
    noLabel?: string;
    timeoutMs?: number;
  }): Promise<{ decision: 'yes' | 'no' | 'timeout'; operatorName?: string }> {
    const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const messageId = await this.feishu.sendConfirmCard({
      chatId: params.chatId,
      actionId,
      title: params.title,
      content: params.content,
      yesLabel: params.yesLabel,
      noLabel: params.noLabel
    });

    if (!messageId) {
      return { decision: 'no' };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        if (this.pendingConfirmations.has(actionId)) {
          this.pendingConfirmations.delete(actionId);
          // 超时锁定卡片
          await this.feishu.updateCardToResolved({
            messageId,
            title: params.title,
            content: params.content,
            decision: 'no',
            operatorName: '操作超时自动取消'
          });
          resolve({ decision: 'timeout' });
        }
      }, params.timeoutMs ?? 5 * 60 * 1000); // 默认 5 分钟超时

      this.pendingConfirmations.set(actionId, {
        actionId,
        chatId: params.chatId,
        title: params.title,
        content: params.content,
        resolve: (decision) => {
          clearTimeout(timer);
          resolve({ decision });
        }
      });
    });
  }

  /**
   * 监听来自飞书的卡片按钮点击回调 (card.action.trigger)
   */
  private setupCardActionListeners(): void {
    this.feishu.onCardAction(async (actionEvt: CardActionContext) => {
      this.ctx.logger.info('Received Feishu card action click:', actionEvt);

      const actionId = actionEvt.actionId;
      const decision = (actionEvt.decision === 'yes' ? 'yes' : 'no') as 'yes' | 'no';

      if (actionId && this.pendingConfirmations.has(actionId)) {
        const pending = this.pendingConfirmations.get(actionId)!;
        this.pendingConfirmations.delete(actionId);

        // 1. 就地把卡片更新为已完成状态（消除按钮，提示已被处理）
        await this.feishu.updateCardToResolved({
          messageId: actionEvt.messageId,
          title: pending.title,
          content: pending.content,
          decision,
          operatorName: actionEvt.operatorName || '飞书用户'
        });

        // 2. 解除 Promise 等待，通知业务逻辑
        pending.resolve(decision);

        // 3. 同时给对应的 Finch Session 投递一条状态更新通知
        const sessionId = this.chatSessions.get(actionEvt.chatId);
        if (sessionId) {
          void this.ctx.sessions.send(sessionId, {
            text: `[系统消息] 飞书用户 ${actionEvt.operatorName || '成员'} 针对「${pending.title}」做出了授权决策：【${decision === 'yes' ? '允许/同意' : '拒绝'}】。`,
            idempotencyKey: `decision_${actionId}_${Date.now()}`
          });
        }
      }

      return {
        toast: {
          type: decision === 'yes' ? 'success' : 'warning',
          content: decision === 'yes' ? '已确认允许' : '已取消/拒绝'
        }
      };
    });
  }

  /**
   * 监听 Finch 会话事件流
   */
  private setupEventListeners(): void {
    this.ctx.sessions.onDidReceiveEvent(async (event: any) => {
      const turnId = event.turnId;
      if (!turnId) return;

      const stream = this.activeStreams.get(turnId);
      if (!stream) return;

      switch (event.type) {
        case 'assistant.delta': {
          // 累加生成的流式文本
          if (typeof event.delta === 'string') {
            stream.textBuffer += event.delta;
          }

          // 节流推送至飞书卡片（100ms 刷新率，飞书原生打字机动画将平滑展开）
          const now = Date.now();
          if (now - stream.lastPatchTime > 100) {
            stream.lastPatchTime = now;
            if (stream.cardHandle && stream.textBuffer) {
              void this.feishu.updateStreamingContent(stream.cardHandle, stream.textBuffer);
            }
          } else if (!stream.patchTimer) {
            stream.patchTimer = setTimeout(() => {
              stream.patchTimer = null;
              stream.lastPatchTime = Date.now();
              if (stream.cardHandle && stream.textBuffer) {
                void this.feishu.updateStreamingContent(stream.cardHandle, stream.textBuffer);
              }
            }, 100);
          }
          break;
        }

        case 'turn.completed': {
          if (stream.patchTimer) {
            clearTimeout(stream.patchTimer);
            stream.patchTimer = null;
          }

          const finalContent = event.message?.text || stream.textBuffer;
          if (stream.cardHandle) {
            await this.feishu.finishStreaming(stream.cardHandle, finalContent);
          }
          this.activeStreams.delete(turnId);
          break;
        }

        case 'turn.failed': {
          if (stream.patchTimer) {
            clearTimeout(stream.patchTimer);
            stream.patchTimer = null;
          }

          const errorContent = (stream.textBuffer ? stream.textBuffer + '\n\n' : '') + `> ⚠️ **生成中断或失败**: ${event.error?.message || '未知错误'}`;
          if (stream.cardHandle) {
            await this.feishu.finishStreaming(stream.cardHandle, errorContent);
          }
          this.activeStreams.delete(turnId);
          break;
        }
      }
    });
  }
}
