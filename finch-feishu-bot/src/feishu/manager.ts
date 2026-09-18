import type * as finch from 'finch';
import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuCredentials, InboundMessageContext } from '../types.js';
import { buildStreamingCard } from './card.js';

export class FeishuManager {
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private isConnecting = false;
  private onMessageCallback: ((msg: InboundMessageContext) => Promise<void>) | null = null;

  constructor(private readonly ctx: finch.MiniToolContext) {}

  public onMessage(cb: (msg: InboundMessageContext) => Promise<void>) {
    this.onMessageCallback = cb;
  }

  public async getCredentials(): Promise<FeishuCredentials | null> {
    const appId = await this.ctx.secrets.get('feishu.appId');
    const appSecret = await this.ctx.secrets.get('feishu.appSecret');
    const encryptKey = await this.ctx.secrets.get('feishu.encryptKey');
    const verificationToken = await this.ctx.secrets.get('feishu.verificationToken');

    if (!appId || !appSecret) {
      return null;
    }

    return {
      appId,
      appSecret,
      encryptKey: encryptKey || undefined,
      verificationToken: verificationToken || undefined
    };
  }

  public async saveCredentials(creds: FeishuCredentials): Promise<void> {
    await this.ctx.secrets.set('feishu.appId', creds.appId.trim());
    await this.ctx.secrets.set('feishu.appSecret', creds.appSecret.trim());
    if (creds.encryptKey) {
      await this.ctx.secrets.set('feishu.encryptKey', creds.encryptKey.trim());
    } else {
      await this.ctx.secrets.delete('feishu.encryptKey');
    }
    if (creds.verificationToken) {
      await this.ctx.secrets.set('feishu.verificationToken', creds.verificationToken.trim());
    } else {
      await this.ctx.secrets.delete('feishu.verificationToken');
    }
  }

  public async clearCredentials(): Promise<void> {
    await this.ctx.secrets.delete('feishu.appId');
    await this.ctx.secrets.delete('feishu.appSecret');
    await this.ctx.secrets.delete('feishu.encryptKey');
    await this.ctx.secrets.delete('feishu.verificationToken');
    await this.stop();
  }

  public isConnected(): boolean {
    return !!this.wsClient;
  }

  public async start(): Promise<{ success: boolean; error?: string }> {
    if (this.isConnecting) {
      return { success: false, error: '正在连接中，请勿重复操作' };
    }

    const creds = await this.getCredentials();
    if (!creds) {
      return { success: false, error: '未配置飞书 App ID 或 App Secret' };
    }

    this.isConnecting = true;
    try {
      if (this.wsClient) {
        await this.stop();
      }

      this.client = new lark.Client({
        appId: creds.appId,
        appSecret: creds.appSecret,
        loggerLevel: lark.LoggerLevel.info
      });

      const eventDispatcher = new lark.EventDispatcher({
        encryptKey: creds.encryptKey,
        verificationToken: creds.verificationToken
      });

      // 注册接收消息事件
      eventDispatcher.register({
        'im.message.receive_v1': async (data: any) => {
          try {
            const message = data.message;
            if (!message) return;

            // 忽略机器人自己发送的消息，防止回环
            if (data.sender?.sender_type === 'bot' || data.sender?.sender_id?.open_id === creds.appId) {
              return;
            }

            // 目前主要支持文本类型
            if (message.message_type !== 'text') {
              return;
            }

            let textContent = '';
            try {
              const parsed = JSON.parse(message.content);
              textContent = parsed.text || '';
            } catch {
              textContent = message.content || '';
            }

            // 过滤群聊中的 @ 机器人标签 (格式为 @_user_1 等)
            textContent = textContent.replace(/@_user_\d+\s*/g, '').trim();
            if (!textContent) return;

            if (this.onMessageCallback) {
              await this.onMessageCallback({
                messageId: message.message_id,
                chatId: message.chat_id,
                chatType: message.chat_type === 'group' ? 'group' : 'p2p',
                senderId: data.sender?.sender_id?.open_id || data.sender?.sender_id?.user_id || 'unknown',
                senderName: data.sender?.sender_id?.open_id,
                text: textContent,
                rootId: message.root_id,
                parentId: message.parent_id
              });
            }
          } catch (err) {
            this.ctx.logger.error('Error handling feishu inbound message:', err);
          }
        }
      });

      this.wsClient = new lark.WSClient({
        appId: creds.appId,
        appSecret: creds.appSecret,
        loggerLevel: lark.LoggerLevel.info
      });

      await this.wsClient.start({
        eventDispatcher
      });

      this.ctx.logger.info('Feishu WSClient connected successfully.');
      return { success: true };
    } catch (err: any) {
      this.ctx.logger.error('Failed to start Feishu WSClient:', err);
      await this.stop();
      return { success: false, error: err?.message || String(err) };
    } finally {
      this.isConnecting = false;
    }
  }

  public async stop(): Promise<void> {
    if (this.wsClient) {
      try {
        await (this.wsClient as any).close();
      } catch (err) {
        this.ctx.logger.warn('Error closing wsClient:', err);
      }
      this.wsClient = null;
    }
    this.client = null;
  }

  /**
   * 发送初始回复卡片
   */
  public async sendInitialCard(chatId: string, _replyToMessageId?: string): Promise<string | null> {
    if (!this.client) return null;

    try {
      const card = buildStreamingCard('正在思考中...', 'generating');
      const res = await this.client.im.message.create({
        params: {
          receive_id_type: 'chat_id'
        },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card)
        }
      });

      return res?.data?.message_id || null;
    } catch (err) {
      this.ctx.logger.error('Failed to send initial card to Feishu:', err);
      return null;
    }
  }

  /**
   * 更新卡片内容（流式打字效果）
   */
  public async updateCard(messageId: string, content: string, status: 'generating' | 'completed' | 'failed' = 'generating'): Promise<boolean> {
    if (!this.client) return false;

    try {
      const card = buildStreamingCard(content, status);
      await this.client.im.message.patch({
        path: {
          message_id: messageId
        },
        data: {
          content: JSON.stringify(card)
        }
      });
      return true;
    } catch (err: any) {
      this.ctx.logger.debug('Failed to patch feishu card message:', err?.message || err);
      return false;
    }
  }
}
