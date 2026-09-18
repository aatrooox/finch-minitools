export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
}

export interface InboundMessageContext {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  senderId: string;
  senderName?: string;
  text: string;
  rootId?: string;
  parentId?: string;
}

export interface OutboundStreamTarget {
  chatId: string;
  replyToMessageId?: string;
  feishuCardMessageId?: string;
  cardId?: string;
  content: string;
  isCompleted: boolean;
}
