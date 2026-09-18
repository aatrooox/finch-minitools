import type * as finch from 'finch';
import type { FeishuManager, CardSessionHandle } from '../feishu/manager.js';
import type { InboundMessageContext, CardActionContext } from '../types.js';
import {
  buildQuestionCard,
  buildQuestionResolvedCard,
  buildPermissionWaitCard,
  buildPermissionWaitResolvedCard,
  buildFollowupStreamingCard
} from '../feishu/card.js';

interface StreamState {
  chatId: string;
  // 原生 CardKit 2.0 流式卡片句柄（用于常规回答）
  cardHandle?: CardSessionHandle | null;
  // 就地接力卡片消息 ID（用于授权/选择后续流式输出）
  targetMessageId?: string;
  metaHeader?: string;
  metaSummary?: string;
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

interface PendingWaitState {
  requestId: string;
  sessionId: string;
  turnId: string;
  chatId: string;
  wait: finch.SessionWait;
  cardMessageId?: string;
  cardData?: {
    kind: finch.SessionWaitKind;
    header?: string;
    question?: string;
    toolName?: string;
    toolTitle?: string;
  };
}

const STORAGE_SESSION_PREFIX = 'feishu:session:';

export class BridgeManager {
  // 保存活跃 Turn 的流式输出状态: key 为 turnId
  private activeStreams = new Map<string, StreamState>();
  // 会话映射：chatId -> sessionId 内存缓存
  private chatSessions = new Map<string, string>();
  // 会话反向映射：sessionId -> chatId
  private sessionChats = new Map<string, string>();
  // 等待用户点击确认的卡片：actionId -> PendingConfirmation
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  // 等待用户交互（提问/授权）的状态缓存
  private pendingWaitsByChat = new Map<string, PendingWaitState>();
  private pendingWaitsByRequest = new Map<string, PendingWaitState>();

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
        this.sessionChats.set(sessionId, msg.chatId);
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
        this.sessionChats.set(persistedSessionId, msg.chatId);
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
    this.sessionChats.set(sessionId, msg.chatId);
    await this.ctx.storage.set(storageKey, sessionId);
    return sessionId;
  }

  /**
   * 通过 sessionId 反查绑定的飞书 chatId（支持内存与 ctx.storage 扫描）
   */
  private async findChatIdForSession(sessionId: string): Promise<string | undefined> {
    const memoryChatId = this.sessionChats.get(sessionId);
    if (memoryChatId) return memoryChatId;

    for (const [cId, sId] of this.chatSessions.entries()) {
      if (sId === sessionId) {
        this.sessionChats.set(sessionId, cId);
        return cId;
      }
    }

    try {
      const keys = await this.ctx.storage.keys();
      for (const k of keys) {
        if (k.startsWith(STORAGE_SESSION_PREFIX)) {
          const storedSessionId = await this.ctx.storage.get<string>(k);
          if (storedSessionId === sessionId) {
            const chatId = k.slice(STORAGE_SESSION_PREFIX.length);
            this.chatSessions.set(chatId, sessionId);
            this.sessionChats.set(sessionId, chatId);
            return chatId;
          }
        }
      }
    } catch (err) {
      this.ctx.logger.error('Failed to scan storage keys for session mapping:', err);
    }

    return undefined;
  }

  /**
   * 处理从飞书收到的消息并转入 Finch Session
   */
  public async handleInboundMessage(msg: InboundMessageContext): Promise<void> {
    const isAutoReply = this.ctx.settings.get<boolean>('autoReply') ?? true;

    try {
      // 1. 优先检查当前 Chat 是否有等待中的提问或授权交互（turn.waiting）
      const pending = this.pendingWaitsByChat.get(msg.chatId);
      if (pending) {
        const rawText = msg.text.trim();
        let handled = false;

        if (pending.wait.kind === 'question') {
          const firstQ = pending.wait.questions?.[0];
          if (firstQ) {
            let chosenAnswer: string | null = null;
            // (1) 匹配纯数字序号（如用户在飞书中直接回复 "1", "2"）
            const numMatch = rawText.match(/^(\d+)$/);
            if (numMatch) {
              const idx = parseInt(numMatch[1], 10) - 1;
              if (idx >= 0 && idx < firstQ.options.length) {
                chosenAnswer = firstQ.options[idx].label;
              }
            }
            // (2) 匹配选项文本内容
            if (!chosenAnswer) {
              for (const opt of firstQ.options) {
                if (rawText.toLowerCase() === opt.label.toLowerCase() || rawText.includes(opt.label)) {
                  chosenAnswer = opt.label;
                  break;
                }
              }
            }
            // (3) 若均未匹配，则作为自由文本应答
            if (!chosenAnswer) {
              chosenAnswer = rawText;
            }

            try {
              const resp = await this.ctx.sessions.respondToWait(pending.sessionId, pending.requestId, {
                kind: 'question',
                answers: { [firstQ.header]: chosenAnswer }
              });

              if (resp.state === 'accepted') {
                handled = true;
                this.pendingWaitsByChat.delete(msg.chatId);
                this.pendingWaitsByRequest.delete(pending.requestId);

                const who = msg.senderName ? ` (操作人: ${msg.senderName})` : '';
                const metaHeader = '❓ 选项确认';
                const metaSummary = `> ❓ **${pending.cardData?.question || '提问'}**\n> **已选择**: 🎯 **${chosenAnswer}**${who}`;

                if (pending.cardMessageId) {
                  const waitingCard = buildFollowupStreamingCard({
                    metaHeader,
                    metaSummary,
                    body: '',
                    isCompleted: false
                  });
                  await this.feishu.updateCard(pending.cardMessageId, waitingCard);

                  // 将后续流式输出接力挂接到该卡片上
                  this.activeStreams.set(pending.turnId, {
                    chatId: pending.chatId,
                    targetMessageId: pending.cardMessageId,
                    metaHeader,
                    metaSummary,
                    textBuffer: '',
                    lastPatchTime: Date.now(),
                    patchTimer: null
                  });
                }
              } else {
                this.ctx.logger.warn(`respondToWait question returned state: ${resp.state}`);
                this.pendingWaitsByChat.delete(msg.chatId);
                this.pendingWaitsByRequest.delete(pending.requestId);
              }
            } catch (err) {
              this.ctx.logger.error('Failed to respondToWait for question:', err);
            }
          }
        } else if (pending.wait.kind === 'permission') {
          const lower = rawText.toLowerCase();
          const isAllow = ['是', '同意', '允许', 'yes', 'y', '1', 'ok', '好的'].some(k => lower.includes(k));
          const isDeny = ['否', '拒绝', '取消', 'no', 'n', '2', '不行', '不'].some(k => lower.includes(k));

          if (isAllow || isDeny) {
            const allow = isAllow;
            try {
              const resp = await this.ctx.sessions.respondToWait(pending.sessionId, pending.requestId, {
                kind: 'permission',
                allow
              });

              if (resp.state === 'accepted') {
                handled = true;
                this.pendingWaitsByChat.delete(msg.chatId);
                this.pendingWaitsByRequest.delete(pending.requestId);

                const who = msg.senderName ? ` (操作人: ${msg.senderName})` : '';
                const metaHeader = '🛡️ 操作授权';
                const statusText = allow ? '✅ **已允许授权**' : '❌ **已拒绝请求**';
                const metaSummary = `> 🛡️ **工具**: \`${pending.cardData?.toolName || '操作'}\`\n> **授权状态**: ${statusText}${who}`;

                if (pending.cardMessageId) {
                  const waitingCard = buildFollowupStreamingCard({
                    metaHeader,
                    metaSummary,
                    body: '',
                    isCompleted: false
                  });
                  await this.feishu.updateCard(pending.cardMessageId, waitingCard);

                  // 将后续流式输出接力挂接到该卡片上
                  this.activeStreams.set(pending.turnId, {
                    chatId: pending.chatId,
                    targetMessageId: pending.cardMessageId,
                    metaHeader,
                    metaSummary,
                    textBuffer: '',
                    lastPatchTime: Date.now(),
                    patchTimer: null
                  });
                }
              } else {
                this.ctx.logger.warn(`respondToWait permission returned state: ${resp.state}`);
                this.pendingWaitsByChat.delete(msg.chatId);
                this.pendingWaitsByRequest.delete(pending.requestId);
              }
            } catch (err) {
              this.ctx.logger.error('Failed to respondToWait for permission:', err);
            }
          }
        }

        // 如果成功结算了等待，直接结束，不开启新的一轮 turn
        if (handled) {
          return;
        }
      }

      const sessionId = await this.getOrCreateSession(msg);

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
        // 按需建卡：先登记状态，收到首个 assistant.delta 时再创建流式卡片
        // 这样如果一上来就触发 turn.waiting，就不会产生上方多余的空流式卡片
        this.activeStreams.set(receipt.turnId, {
          chatId: msg.chatId,
          cardHandle: null,
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

      const rawVal = typeof actionEvt.rawValue === 'object' && actionEvt.rawValue !== null
        ? actionEvt.rawValue
        : {};
      const waitRequestId = rawVal.waitRequestId || actionEvt.actionId;
      const waitKind = rawVal.kind;

      // 1. 优先检查是否命中待处理的 Finch 交互等待 (turn.waiting)
      if (waitRequestId && this.pendingWaitsByRequest.has(waitRequestId)) {
        const pending = this.pendingWaitsByRequest.get(waitRequestId)!;
        if (waitKind === 'question') {
          const answer = String(rawVal.answer || actionEvt.decision || '');
          const header = String(rawVal.header || pending.cardData?.header || 'header');
          try {
            const resp = await this.ctx.sessions.respondToWait(pending.sessionId, pending.requestId, {
              kind: 'question',
              answers: { [header]: answer }
            });
            if (resp.state === 'accepted') {
              this.pendingWaitsByChat.delete(pending.chatId);
              this.pendingWaitsByRequest.delete(waitRequestId);

              const who = actionEvt.operatorName ? ` (操作人: ${actionEvt.operatorName})` : '';
              const metaHeader = '❓ 选项确认';
              const metaSummary = `> ❓ **${pending.cardData?.question || '提问'}**\n> **已选择**: 🎯 **${answer}**${who}`;

              if (actionEvt.messageId) {
                const waitingCard = buildFollowupStreamingCard({
                  metaHeader,
                  metaSummary,
                  body: '',
                  isCompleted: false
                });
                await this.feishu.updateCard(actionEvt.messageId, waitingCard);

                // 将后续流式输出接力挂接到该卡片上
                this.activeStreams.set(pending.turnId, {
                  chatId: pending.chatId,
                  targetMessageId: actionEvt.messageId,
                  metaHeader,
                  metaSummary,
                  textBuffer: '',
                  lastPatchTime: Date.now(),
                  patchTimer: null
                });
              }
              return {
                toast: {
                  type: 'success',
                  content: `已选择：${answer}`
                }
              };
            }
          } catch (err) {
            this.ctx.logger.error('Failed to respondToWait for card button question:', err);
          }
        } else if (waitKind === 'permission') {
          const allow = rawVal.allow === true || actionEvt.decision === 'yes';
          try {
            const resp = await this.ctx.sessions.respondToWait(pending.sessionId, pending.requestId, {
              kind: 'permission',
              allow
            });
            if (resp.state === 'accepted') {
              this.pendingWaitsByChat.delete(pending.chatId);
              this.pendingWaitsByRequest.delete(waitRequestId);

              const who = actionEvt.operatorName ? ` (操作人: ${actionEvt.operatorName})` : '';
              const metaHeader = '🛡️ 操作授权';
              const statusText = allow ? '✅ **已允许授权**' : '❌ **已拒绝请求**';
              const metaSummary = `> 🛡️ **工具**: \`${pending.cardData?.toolName || '操作'}\`\n> **授权状态**: ${statusText}${who}`;

              if (actionEvt.messageId) {
                const waitingCard = buildFollowupStreamingCard({
                  metaHeader,
                  metaSummary,
                  body: '',
                  isCompleted: false
                });
                await this.feishu.updateCard(actionEvt.messageId, waitingCard);

                // 将后续流式输出接力挂接到该卡片上
                this.activeStreams.set(pending.turnId, {
                  chatId: pending.chatId,
                  targetMessageId: actionEvt.messageId,
                  metaHeader,
                  metaSummary,
                  textBuffer: '',
                  lastPatchTime: Date.now(),
                  patchTimer: null
                });
              }
              return {
                toast: {
                  type: allow ? 'success' : 'warning',
                  content: allow ? '已允许授权' : '已拒绝请求'
                }
              };
            }
          } catch (err) {
            this.ctx.logger.error('Failed to respondToWait for card button permission:', err);
          }
        }
      }

      // 2. 检查是否属于 agent tool 发起的普通确认卡片
      const actionId = actionEvt.actionId;
      const decision = (actionEvt.decision === 'yes' ? 'yes' : 'no') as 'yes' | 'no';

      if (actionId && this.pendingConfirmations.has(actionId)) {
        const pending = this.pendingConfirmations.get(actionId)!;
        this.pendingConfirmations.delete(actionId);

        // 就地把卡片更新为已完成状态
        await this.feishu.updateCardToResolved({
          messageId: actionEvt.messageId,
          title: pending.title,
          content: pending.content,
          decision,
          operatorName: actionEvt.operatorName || '飞书用户'
        });

        pending.resolve(decision);

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
      const stream = turnId ? this.activeStreams.get(turnId) : undefined;

      switch (event.type) {
        case 'assistant.delta': {
          if (!stream) return;
          // 累加生成的流式文本
          if (typeof event.delta === 'string') {
            stream.textBuffer += event.delta;
          }

          // 若属于常规会话且尚未建卡，按需创建飞书原生流式卡片
          if (!stream.cardHandle && !stream.targetMessageId) {
            stream.cardHandle = await this.feishu.createStreamingCard(stream.chatId);
          }

          const now = Date.now();
          const throttleInterval = stream.targetMessageId ? 300 : 100; // 普通卡片 patch 限制 300ms 避免 429

          const doUpdate = async () => {
            if (stream.targetMessageId && stream.metaSummary) {
              const card = buildFollowupStreamingCard({
                metaHeader: stream.metaHeader,
                metaSummary: stream.metaSummary,
                body: stream.textBuffer,
                isCompleted: false
              });
              await this.feishu.updateCard(stream.targetMessageId, card);
            } else if (stream.cardHandle && stream.textBuffer) {
              void this.feishu.updateStreamingContent(stream.cardHandle, stream.textBuffer);
            }
          };

          if (now - stream.lastPatchTime > throttleInterval) {
            stream.lastPatchTime = now;
            void doUpdate();
          } else if (!stream.patchTimer) {
            stream.patchTimer = setTimeout(() => {
              stream.patchTimer = null;
              stream.lastPatchTime = Date.now();
              void doUpdate();
            }, throttleInterval);
          }
          break;
        }

        case 'turn.waiting': {
          // 1. 如果当前 turn 正在流式输出，先结算流式卡片，避免悬挂
          if (stream) {
            if (stream.patchTimer) {
              clearTimeout(stream.patchTimer);
              stream.patchTimer = null;
            }
            if (stream.cardHandle && stream.textBuffer.trim()) {
              await this.feishu.finishStreaming(stream.cardHandle, stream.textBuffer);
            }
            this.activeStreams.delete(turnId);
          }

          // 2. 找到绑定的飞书 Chat ID
          const chatId = await this.findChatIdForSession(event.sessionId);
          if (!chatId) {
            this.ctx.logger.warn(`turn.waiting: no chatId found for session ${event.sessionId}`);
            break;
          }

          const wait = event.wait as finch.SessionWait;
          const requestId = event.requestId;
          let cardMessageId: string | undefined;
          let cardData: any = { kind: wait.kind };

          try {
            if (wait.kind === 'question') {
              const firstQ = wait.questions?.[0];
              if (firstQ) {
                const qCard = buildQuestionCard({
                  requestId,
                  header: firstQ.header,
                  question: firstQ.question,
                  options: firstQ.options
                });
                const msgId = await this.feishu.sendCard(chatId, qCard);
                if (msgId) cardMessageId = msgId;
                cardData = {
                  kind: 'question',
                  header: firstQ.header,
                  question: firstQ.question
                };
              }
            } else if (wait.kind === 'permission') {
              const pCard = buildPermissionWaitCard({
                requestId,
                toolName: wait.toolName,
                toolTitle: wait.toolTitle,
                toolInput: wait.toolInput
              });
              const msgId = await this.feishu.sendCard(chatId, pCard);
              if (msgId) cardMessageId = msgId;
              cardData = {
                kind: 'permission',
                toolName: wait.toolName,
                toolTitle: wait.toolTitle
              };
            } else if (wait.kind === 'form') {
              const formTitle = wait.form?.title || '表单待提交';
              const formDesc = wait.form?.description || 'Agent 需要您在 Finch 客户端中提交表单以继续。';
              const text = `📋 **${formTitle}**\n\n${formDesc}`;
              await this.feishu.sendCard(chatId, {
                config: { wide_screen_mode: true },
                header: { template: 'blue', title: { tag: 'plain_text', content: formTitle } },
                elements: [{ tag: 'markdown', content: text }]
              });
            }
          } catch (err) {
            this.ctx.logger.error('Failed to send wait card to Feishu:', err);
          }

          const pendingState: PendingWaitState = {
            requestId,
            sessionId: event.sessionId,
            turnId: turnId || '',
            chatId,
            wait,
            cardMessageId,
            cardData
          };
          this.pendingWaitsByChat.set(chatId, pendingState);
          this.pendingWaitsByRequest.set(requestId, pendingState);
          break;
        }

        case 'turn.wait_resolved': {
          const pending = this.pendingWaitsByRequest.get(event.requestId);
          if (pending) {
            this.pendingWaitsByChat.delete(pending.chatId);
            this.pendingWaitsByRequest.delete(event.requestId);
          }
          break;
        }

        case 'turn.completed': {
          if (!stream) return;
          if (stream.patchTimer) {
            clearTimeout(stream.patchTimer);
            stream.patchTimer = null;
          }

          const finalContent = event.message?.text || stream.textBuffer;
          if (stream.targetMessageId && stream.metaSummary) {
            const finalCard = buildFollowupStreamingCard({
              metaHeader: stream.metaHeader,
              metaSummary: stream.metaSummary,
              body: finalContent,
              isCompleted: true
            });
            await this.feishu.updateCard(stream.targetMessageId, finalCard);
          } else if (stream.cardHandle) {
            await this.feishu.finishStreaming(stream.cardHandle, finalContent);
          }
          this.activeStreams.delete(turnId);
          break;
        }

        case 'turn.failed': {
          if (!stream) return;
          if (stream.patchTimer) {
            clearTimeout(stream.patchTimer);
            stream.patchTimer = null;
          }

          const errorContent = (stream.textBuffer ? stream.textBuffer + '\n\n' : '') + `> ⚠️ **生成中断或失败**: ${event.error?.message || '未知错误'}`;
          if (stream.targetMessageId && stream.metaSummary) {
            const failedCard = buildFollowupStreamingCard({
              metaHeader: stream.metaHeader,
              metaSummary: stream.metaSummary,
              body: errorContent,
              isCompleted: true
            });
            await this.feishu.updateCard(stream.targetMessageId, failedCard);
          } else if (stream.cardHandle) {
            await this.feishu.finishStreaming(stream.cardHandle, errorContent);
          }
          this.activeStreams.delete(turnId);
          break;
        }
      }
    });
  }
}
