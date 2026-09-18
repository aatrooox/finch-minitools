import type * as finch from 'finch';
import type { FeishuManager } from '../feishu/manager.js';
import type { InboundMessageContext } from '../types.js';

interface StreamState {
  chatId: string;
  cardMessageId: string | null;
  textBuffer: string;
  lastPatchTime: number;
  patchTimer: NodeJS.Timeout | null;
}

export class BridgeManager {
  // 保存活跃 Turn 的流式输出状态: key 为 turnId
  private activeStreams = new Map<string, StreamState>();
  // 会话映射：chatId -> sessionId
  private chatSessions = new Map<string, string>();

  constructor(
    private readonly ctx: finch.MiniToolContext,
    private readonly feishu: FeishuManager
  ) {
    this.setupEventListeners();
  }

  /**
   * 处理从飞书收到的消息并转入 Finch Session
   */
  public async handleInboundMessage(msg: InboundMessageContext): Promise<void> {
    const isAutoReply = this.ctx.settings.get<boolean>('autoReply') ?? true;

    try {
      let sessionId = this.chatSessions.get(msg.chatId);

      // 如果尚未为此聊天建立 Finch Session，则在 feishu 容器内创建
      if (!sessionId) {
        const title = msg.chatType === 'group' ? `群聊: ${msg.chatId.slice(-6)}` : `用户: ${msg.senderId.slice(-6)}`;
        const sessionInfo = await this.ctx.sessions.create({
          containerId: 'feishu',
          title
        });
        sessionId = sessionInfo.sessionId;
        this.chatSessions.set(msg.chatId, sessionId);
      }

      let cardMessageId: string | null = null;
      if (isAutoReply) {
        // 先向飞书发送一张初始的“正在思考中”卡片
        cardMessageId = await this.feishu.sendInitialCard(msg.chatId, msg.messageId);
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
          cardMessageId,
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

          // 节流推送，避免飞书频控限制（限制每 800ms 刷新一次）
          const now = Date.now();
          if (now - stream.lastPatchTime > 800) {
            stream.lastPatchTime = now;
            if (stream.cardMessageId) {
              void this.feishu.updateCard(stream.cardMessageId, stream.textBuffer, 'generating');
            }
          } else if (!stream.patchTimer) {
            stream.patchTimer = setTimeout(() => {
              stream.patchTimer = null;
              stream.lastPatchTime = Date.now();
              if (stream.cardMessageId) {
                void this.feishu.updateCard(stream.cardMessageId, stream.textBuffer, 'generating');
              }
            }, 800);
          }
          break;
        }

        case 'turn.completed': {
          if (stream.patchTimer) {
            clearTimeout(stream.patchTimer);
            stream.patchTimer = null;
          }

          // 最终结算：如果 message 里有完整正文则优先取完整正文
          const finalContent = event.message?.text || stream.textBuffer;
          if (stream.cardMessageId) {
            await this.feishu.updateCard(stream.cardMessageId, finalContent, 'completed');
          }
          this.activeStreams.delete(turnId);
          break;
        }

        case 'turn.failed': {
          if (stream.patchTimer) {
            clearTimeout(stream.patchTimer);
            stream.patchTimer = null;
          }

          const errorContent = (stream.textBuffer ? stream.textBuffer + '\n\n' : '') + `[生成中断或失败: ${event.error?.message || '未知错误'}]`;
          if (stream.cardMessageId) {
            await this.feishu.updateCard(stream.cardMessageId, errorContent, 'failed');
          }
          this.activeStreams.delete(turnId);
          break;
        }
      }
    });
  }
}
