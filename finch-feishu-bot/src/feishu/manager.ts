import type * as finch from 'finch';
import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuCredentials, InboundMessageContext, CardActionContext } from '../types.js';
import {
  buildCardkitStreamingCard,
  buildActionConfirmCard,
  buildActionResolvedCard,
  DEFAULT_ELEMENT_ID
} from './card.js';

export interface CardSessionHandle {
  cardId: string;
  messageId: string;
  sequence: number;
}

function parseInboundMessageContent(messageType: string, contentStr: string): string {
  if (!contentStr) return '';
  try {
    const parsed = JSON.parse(contentStr);
    if (messageType === 'text') {
      return parsed.text || '';
    }
    if (messageType === 'post') {
      const postBody = parsed.zh_cn || parsed.en_us || parsed.ja_jp || Object.values(parsed)[0];
      if (!postBody || typeof postBody !== 'object') {
        return '';
      }
      const lines: string[] = [];
      if (postBody.title && typeof postBody.title === 'string') {
        lines.push(postBody.title);
      }
      if (Array.isArray(postBody.content)) {
        for (const paragraph of postBody.content) {
          if (Array.isArray(paragraph)) {
            let lineText = '';
            for (const elem of paragraph) {
              if (!elem) continue;
              if (elem.tag === 'text' && typeof elem.text === 'string') {
                lineText += elem.text;
              } else if (elem.tag === 'a' && typeof elem.text === 'string') {
                lineText += elem.href ? `[${elem.text}](${elem.href})` : elem.text;
              } else if (elem.tag === 'at') {
                if (elem.user_name) {
                  lineText += `@${elem.user_name} `;
                }
              } else if (elem.tag === 'code_block' && typeof elem.text === 'string') {
                lineText += `\n\`\`\`\n${elem.text}\n\`\`\`\n`;
              }
            }
            if (lineText) {
              lines.push(lineText);
            }
          }
        }
      }
      return lines.join('\n');
    }
    return parsed.text || contentStr;
  } catch {
    return contentStr;
  }
}

export class FeishuManager {
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private isConnecting = false;
  private onMessageCallback: ((msg: InboundMessageContext) => Promise<void>) | null = null;
  private onCardActionCallback: ((action: CardActionContext) => Promise<any>) | null = null;

  constructor(private readonly ctx: finch.MiniToolContext) {}

  public onMessage(cb: (msg: InboundMessageContext) => Promise<void>) {
    this.onMessageCallback = cb;
  }

  public onCardAction(cb: (action: CardActionContext) => Promise<any>) {
    this.onCardActionCallback = cb;
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

      // 1. 注册接收普通消息事件
      eventDispatcher.register({
        'im.message.receive_v1': async (data: any) => {
          try {
            const message = data.message;
            if (!message) return;

            // 忽略机器人自己发送的消息，防止回环
            if (data.sender?.sender_type === 'bot' || data.sender?.sender_id?.open_id === creds.appId) {
              return;
            }

            // 支持文本及富文本 post 消息类型
            if (message.message_type !== 'text' && message.message_type !== 'post') {
              return;
            }

            let textContent = parseInboundMessageContent(message.message_type, message.content);

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
        },

        // 2. 注册卡片交互动作事件 (card.action.trigger) - 监听用户在飞书点击按钮的回调
        'card.action.trigger': async (data: any) => {
          try {
            this.ctx.logger.info('card.action.trigger received data:', JSON.stringify(data));
            const messageId = data.context?.open_message_id
              || data.open_message_id
              || data.message_id
              || data.event?.context?.open_message_id
              || data.event?.open_message_id;
            const chatId = data.context?.open_chat_id
              || data.open_chat_id
              || data.chat_id
              || data.event?.context?.open_chat_id
              || data.event?.open_chat_id;
            const operatorOpenId = data.operator?.open_id || data.event?.operator?.open_id;
            const operatorUserId = data.operator?.user_id || data.event?.operator?.user_id;
            const operatorName = data.operator?.name || data.event?.operator?.name;
            const actionVal = data.action?.value || data.event?.action?.value;

            let actionId: string | undefined;
            let decision: 'yes' | 'no' | string | undefined;

            if (typeof actionVal === 'object' && actionVal !== null) {
              actionId = actionVal.actionId;
              decision = actionVal.decision;
            } else if (typeof actionVal === 'string') {
              try {
                const parsed = JSON.parse(actionVal);
                actionId = parsed.actionId;
                decision = parsed.decision;
              } catch {
                decision = actionVal;
              }
            }

            if (this.onCardActionCallback) {
              await this.onCardActionCallback({
                messageId,
                chatId,
                operatorOpenId,
                operatorUserId,
                operatorName,
                actionId,
                decision,
                rawValue: actionVal
              });
            }
          } catch (err) {
            this.ctx.logger.error('Error handling card.action.trigger:', err);
          }
          // 统一返回空对象响应 ACK，所有卡片更新完全走异步 updateCard，避免触发飞书客户端 code 200672 弹窗
          return {};
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
   * 发送任意飞书卡片消息 (interactive)
   */
  public async sendCard(chatId: string, card: any): Promise<string | null> {
    if (!this.client) return null;

    try {
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
      this.ctx.logger.error('Failed to send card to Feishu:', err);
      return null;
    }
  }

  /**
   * 更新已发送的飞书卡片消息
   */
  public async updateCard(messageId: string, card: any): Promise<boolean> {
    if (!this.client) return false;

    try {
      await this.client.im.message.patch({
        path: {
          message_id: messageId
        },
        data: {
          content: JSON.stringify(card)
        }
      });
      return true;
    } catch (err) {
      this.ctx.logger.error('Failed to patch card message:', err);
      return false;
    }
  }

  /**
   * 发送带 Yes / No 按钮的交互式确认卡片
   */
  public async sendConfirmCard(params: {
    chatId: string;
    actionId: string;
    title: string;
    content: string;
    yesLabel?: string;
    noLabel?: string;
  }): Promise<string | null> {
    const card = buildActionConfirmCard(params);
    return this.sendCard(params.chatId, card);
  }

  /**
   * 将已点击的交互卡片就地更新为结果状态卡片（防止重复点击，并清晰提示谁在何时点击了授权）
   */
  public async updateCardToResolved(params: {
    messageId: string;
    title: string;
    content: string;
    decision: 'yes' | 'no';
    operatorName?: string;
  }): Promise<boolean> {
    const card = buildActionResolvedCard(params);
    return this.updateCard(params.messageId, card);
  }

  /**
   * 创建飞书原生流式卡片并发送到会话
   */
  public async createStreamingCard(chatId: string): Promise<CardSessionHandle | null> {
    if (!this.client) return null;

    try {
      // 1. 创建流式卡片实体，获得 card_id
      const initialCard = buildCardkitStreamingCard('');
      const cardRes = await this.client.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(initialCard)
        }
      });

      const cardId = cardRes?.data?.card_id;
      if (!cardId) {
        throw new Error('cardkit.v1.card.create returned no card_id');
      }

      // 2. 将创建好的卡片引用发送到群聊/单聊
      const msgRes = await this.client.im.message.create({
        params: {
          receive_id_type: 'chat_id'
        },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({
            type: 'card',
            data: {
              card_id: cardId
            }
          })
        }
      });

      const messageId = msgRes?.data?.message_id;
      if (!messageId) {
        throw new Error('im.message.create returned no message_id');
      }

      return {
        cardId,
        messageId,
        sequence: 1
      };
    } catch (err) {
      this.ctx.logger.error('Failed to createStreamingCard:', err);
      return null;
    }
  }

  /**
   * 原生流式更新卡片元素内容（飞书客户端原生打字机动画 + 原生光标）
   */
  public async updateStreamingContent(handle: CardSessionHandle, content: string): Promise<boolean> {
    if (!this.client) return false;

    try {
      handle.sequence += 1;
      const seq = handle.sequence;
      await this.client.cardkit.v1.cardElement.content({
        path: {
          card_id: handle.cardId,
          element_id: DEFAULT_ELEMENT_ID
        },
        data: {
          content,
          sequence: seq,
          uuid: `c_${handle.cardId}_${seq}`
        }
      });
      return true;
    } catch (err: any) {
      this.ctx.logger.debug('Failed to updateStreamingContent:', err?.message || err);
      return false;
    }
  }

  /**
   * 结束流式输出（关闭 streaming_mode，锁定卡片，消除原生光标）
   */
  public async finishStreaming(handle: CardSessionHandle, finalContent?: string): Promise<void> {
    if (!this.client) return;

    try {
      if (finalContent) {
        await this.updateStreamingContent(handle, finalContent);
      }

      handle.sequence += 1;
      const seq = handle.sequence;
      const config = { streaming_mode: false };

      await this.client.cardkit.v1.card.settings({
        path: {
          card_id: handle.cardId
        },
        data: {
          settings: JSON.stringify({ config }),
          sequence: seq,
          uuid: `s_${handle.cardId}_${seq}`
        }
      });
    } catch (err: any) {
      this.ctx.logger.debug('Failed to finishStreaming card:', err?.message || err);
    }
  }
}
