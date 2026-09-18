import type * as finch from 'finch';
import { FeishuManager } from './feishu/manager.js';
import { BridgeManager } from './finch/bridge.js';

export async function activate(ctx: finch.MiniToolContext) {
  ctx.logger.info('Activating Finch Feishu Bot...');

  const feishu = new FeishuManager(ctx);
  const bridge = new BridgeManager(ctx, feishu);

  feishu.onMessage(async (msg) => {
    await bridge.handleInboundMessage(msg);
  });

  // 尝试自动启动连接（如果已经配置过密钥）
  void feishu.start().then((res) => {
    if (res.success) {
      ctx.logger.info('Feishu Bot auto-started.');
    } else {
      ctx.logger.info('Feishu Bot not connected:', res.error);
    }
  });

  // 注册统一设置菜单（在收件箱顶栏以及工具箱卡片上展示）
  const menuHandle = ctx.settingsMenu.register({
    async getMenu() {
      const isConnected = feishu.isConnected();
      const creds = await feishu.getCredentials();

      return [
        {
          id: 'status',
          label: isConnected ? '飞书状态 · 已长连接' : '飞书状态 · 未连接',
          description: creds ? `App ID: ${creds.appId}` : '未配置 App ID',
          iconName: isConnected ? 'check-circle' : 'circle-off',
          disabled: true
        },
        isConnected
          ? {
              id: 'disconnect',
              label: '断开飞书长连接',
              iconName: 'unplug'
            }
          : {
              id: 'connect',
              label: '启动飞书长连接',
              iconName: 'play',
              disabled: !creds
            },
        {
          id: 'config',
          label: '配置飞书凭据 (App ID / Secret)',
          iconName: 'sliders'
        },
        ...(creds
          ? [
              {
                id: 'clear',
                label: '清除凭据',
                iconName: 'trash-2'
              }
            ]
          : [])
      ];
    },

    async execute(_menuCtx: finch.SettingsMenuContext, itemId: string) {
      if (itemId === 'config') {
        const creds = await feishu.getCredentials();
        const res = await ctx.ui.showModalDialog({
          title: '配置飞书机器人凭据',
          message: '请在飞书开放平台创建“企业自建应用”，开启机器人能力并开通长连接事件监听。',
          actions: [
            { id: 'cancel', label: '取消' },
            { id: 'save', label: '保存并连接', variant: 'primary' }
          ],
          fields: [
            {
              key: 'appId',
              label: 'App ID (cli_xxx)',
              type: 'text',
              required: true,
              default: creds?.appId || ''
            },
            {
              key: 'appSecret',
              label: 'App Secret',
              type: 'password',
              secret: true,
              required: true,
              default: creds?.appSecret || ''
            },
            {
              key: 'encryptKey',
              label: 'Encrypt Key (可选)',
              type: 'password',
              secret: true,
              required: false,
              default: creds?.encryptKey || ''
            },
            {
              key: 'verificationToken',
              label: 'Verification Token (可选)',
              type: 'password',
              secret: true,
              required: false,
              default: creds?.verificationToken || ''
            }
          ]
        });

        if (res.action === 'save' && res.values) {
          await feishu.saveCredentials({
            appId: String(res.values.appId || ''),
            appSecret: String(res.values.appSecret || ''),
            encryptKey: res.values.encryptKey ? String(res.values.encryptKey) : undefined,
            verificationToken: res.values.verificationToken ? String(res.values.verificationToken) : undefined
          });

          ctx.ui.notify('正在建立飞书长连接...', 'info');
          const startRes = await feishu.start();
          if (startRes.success) {
            ctx.ui.notify('飞书长连接建立成功！', 'info');
          } else {
            ctx.ui.notify(`连接失败: ${startRes.error}`, 'error');
          }
          menuHandle.notifyUpdate();
        }
      } else if (itemId === 'connect') {
        ctx.ui.notify('正在连接飞书...', 'info');
        const startRes = await feishu.start();
        if (startRes.success) {
          ctx.ui.notify('飞书连接成功！', 'info');
        } else {
          ctx.ui.notify(`连接失败: ${startRes.error}`, 'error');
        }
        menuHandle.notifyUpdate();
      } else if (itemId === 'disconnect') {
        await feishu.stop();
        ctx.ui.notify('已断开飞书长连接', 'info');
        menuHandle.notifyUpdate();
      } else if (itemId === 'clear') {
        const confirmed = await ctx.ui.showConfirmDialog({
          title: '清除飞书凭据',
          message: '确定要清除保存在系统钥匙串中的飞书凭据吗？'
        });
        if (confirmed.confirmed) {
          await feishu.clearCredentials();
          ctx.ui.notify('已清除凭据', 'info');
          menuHandle.notifyUpdate();
        }
      }
    }
  });

  ctx.subscriptions.push(menuHandle);

  // 注册退出或停用时清理长连接
  ctx.subscriptions.push({
    dispose: async () => {
      await feishu.stop();
    }
  });
}
