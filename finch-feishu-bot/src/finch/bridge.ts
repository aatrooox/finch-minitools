import type * as finch from 'finch';
import type { FeishuManager, CardSessionHandle } from '../feishu/manager.js';
import type { InboundMessageContext } from '../types.js';

interface StreamState {
  chatId: string;
  cardHandle: CardSessionHandle | null;
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

      let cardHandle: CardSessionHandle | null = null;
      if (isAutoReply) {
        // 创建飞书原生流式卡片（不含人工伪造字符，交给飞书客户端原生呈现打字机状态）
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
