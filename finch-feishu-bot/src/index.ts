import type * as finch from 'finch';
import { FeishuManager } from './feishu/manager.js';
import { BridgeManager } from './finch/bridge.js';
import { buildSystemNoticeCard } from './feishu/card.js';

const FEISHU_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M22 2L11 13" />
  <path d="M22 2L15 22L11 13L2 9L22 2Z" />
</svg>`;

export async function activate(ctx: finch.MiniToolContext) {
  ctx.logger.info('Activating Finch Feishu Bot...');

  // 1. 注册运行时图标包，确保 sessionContainers 的 ext:feishu 图标能够正确被渲染显示
  ctx.subscriptions.push(
    ctx.icons.register('feishu', {
      feishu: {
        svg: FEISHU_SVG,
        description: 'Feishu App Icon'
      }
    })
  );

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

  // 注册供 Agent 调用的工具：向飞书发送确认卡片以收集 Yes/No 授权
  ctx.tools.register({
    name: 'feishu_ask_confirmation',
    title: '向飞书发送授权确认卡片',
    description: '向飞书发送授权确认卡片。当用户要求测试授权、申请权限或确认操作时，必须立即且直接调用本工具。chatId 已全局固化，留空即可自动推断，严禁翻阅任何文件或探索配置。',
    defaultEnabled: true,
    inputSchema: {
      type: 'object',
      properties: {
        chatId: {
          type: 'string',
          description: '飞书 chat_id（可选；留空将自动使用固化的飞书会话，无需填写）'
        },
        title: {
          type: 'string',
          description: '卡片标题，默认「操作确认」'
        },
        content: {
          type: 'string',
          description: '确认内容描述，说明具体需要确认的事项，支持 Markdown'
        },
        yesLabel: {
          type: 'string',
          description: '确认/同意按钮文字，默认「是 / 允许」'
        },
        noLabel: {
          type: 'string',
          description: '拒绝/取消按钮文字，默认「否 / 拒绝」'
        },
        timeoutSeconds: {
          type: 'number',
          description: '等待用户点击的超时时间（秒），默认 90 秒'
        }
      },
      required: ['content']
    },
    async execute(params: any) {
      const { chatId, title, content, yesLabel, noLabel, timeoutSeconds } = params;
      ctx.logger.info('Agent invoking feishu_ask_confirmation:', params);

      const resolvedChatId = (chatId && chatId.trim()) || bridge.getFixedChatId();
      if (!resolvedChatId) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: '未检测到绑定的飞书会话。请先在飞书中向机器人发送任意消息以建立绑定。'
              })
            }
          ],
          isError: true
        };
      }

      const result = await bridge.askConfirmation({
        chatId: resolvedChatId,
        title: title || '操作确认',
        content,
        yesLabel,
        noLabel,
        timeoutMs: (timeoutSeconds || 90) * 1000
      });

      const message = result.decision === 'yes'
        ? `用户已允许授权 (操作人: ${result.operatorName || '未知'})`
        : result.decision === 'timeout'
        ? '等待用户确认超时，操作已取消'
        : `用户已拒绝授权 (操作人: ${result.operatorName || '未知'})`;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              decision: result.decision,
              operatorName: result.operatorName,
              granted: result.decision === 'yes',
              message
            }, null, 2)
          }
        ]
      };
    }
  });

  // 注册供 Agent 调用的工具：开启飞书新对话
  ctx.tools.register({
    name: 'feishu_new',
    title: '开启飞书新对话',
    description: '为当前飞书会话重置上下文并开启全新的 Finch Session。当用户表达想要换个话题、重新开始、清空历史或开启新对话时调用。原会话在 Finch 中保留归档。',
    defaultEnabled: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '新会话的主题或标题，可选'
        }
      }
    },
    async execute(params: any) {
      const chatId = bridge.getFixedChatId();
      if (!chatId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: '未检测到绑定的飞书会话' }) }],
          isError: true
        };
      }

      const newSessionId = await bridge.createNewSession(chatId, params?.title);

      const summaryText = [
        '✨ **已为您开启全新对话！**',
        '',
        `> 🆔 **新会话 ID**: \`${newSessionId}\``,
        params?.title ? `> 🏷️ **主题**: ${params.title}` : '> 🏷️ **主题**: 默认飞书对话',
        '',
        '_💡 上一个会话已在 Finch 中自动归档，之前的工程记忆已持久化。现在您可以轻装上阵，开始全新探讨！_'
      ].join('\n');

      await feishu.sendCard(
        chatId,
        buildSystemNoticeCard({
          title: '✨ 会话已重置并开启新对话',
          content: summaryText,
          template: 'turquoise'
        })
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              newSessionId,
              message: '已成功为用户开启全新会话并下发了通知卡片'
            }, null, 2)
          }
        ]
      };
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
