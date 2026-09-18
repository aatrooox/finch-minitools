import type * as finch from 'finch';
import type { InboundMessageContext } from '../types.js';
import type { BridgeManager } from '../finch/bridge.js';
import type { FeishuManager } from '../feishu/manager.js';
import { buildSystemNoticeCard } from '../feishu/card.js';

export interface CommandContext {
  msg: InboundMessageContext;
  rawCommand: string;
  args: string;
  bridge: BridgeManager;
  ctx: finch.MiniToolContext;
  feishu: FeishuManager;
  registry: CommandRegistry;
}

export interface CommandDefinition {
  /** 规范指令名称，例如 '/new' */
  name: string;
  /** 别名列表，例如 ['/reset', '/clear', '新建会话'] */
  aliases?: string[];
  /** 简短功能描述，会自动渲染到 /help 菜单中 */
  description: string;
  /** 详细使用帮助（可选） */
  usage?: string;
  /** 执行指令处理逻辑 */
  execute: (ctx: CommandContext) => Promise<boolean | void>;
}

export class CommandRegistry {
  private commands: CommandDefinition[] = [];
  private commandMap = new Map<string, CommandDefinition>();

  constructor(
    private readonly ctx: finch.MiniToolContext,
    private readonly bridge: BridgeManager,
    private readonly feishu: FeishuManager
  ) {
    this.registerBuiltinCommands();
  }

  /**
   * 注册一个快捷指令。后续增加新指令只需调用此方法声明，无需修改网关分发代码。
   */
  public register(cmd: CommandDefinition): this {
    this.commands.push(cmd);
    const keys = [cmd.name.toLowerCase(), ...(cmd.aliases || []).map(a => a.toLowerCase())];
    for (const k of keys) {
      this.commandMap.set(k, cmd);
    }
    return this;
  }

  /**
   * 获取当前已注册的所有指令列表
   */
  public listCommands(): readonly CommandDefinition[] {
    return this.commands;
  }

  /**
   * 尝试匹配并分发用户输入。如果命中快捷指令并处理，返回 true；否则返回 false 交由大模型推理。
   */
  public async dispatch(msg: InboundMessageContext): Promise<boolean> {
    const text = msg.text.trim();
    if (!text) return false;

    // 解析指令和参数：例如 "/new 关于登录界面的重构" -> cmdKey: "/new", args: "关于登录界面的重构"
    const firstSpace = text.indexOf(' ');
    const firstNewline = text.indexOf('\n');
    let splitIdx = -1;
    if (firstSpace !== -1 && firstNewline !== -1) {
      splitIdx = Math.min(firstSpace, firstNewline);
    } else {
      splitIdx = firstSpace !== -1 ? firstSpace : firstNewline;
    }

    const rawCmd = splitIdx === -1 ? text : text.slice(0, splitIdx).trim();
    const args = splitIdx === -1 ? '' : text.slice(splitIdx + 1).trim();

    const matched = this.commandMap.get(rawCmd.toLowerCase());
    if (!matched) {
      return false;
    }

    this.ctx.logger.info(`Dispatching command: ${matched.name} with args: "${args}" from user: ${msg.senderName || msg.senderId}`);

    const cmdCtx: CommandContext = {
      msg,
      rawCommand: rawCmd,
      args,
      bridge: this.bridge,
      ctx: this.ctx,
      feishu: this.feishu,
      registry: this
    };

    try {
      const handled = await matched.execute(cmdCtx);
      return handled !== false;
    } catch (err) {
      this.ctx.logger.error(`Error executing command ${matched.name}:`, err);
      await this.feishu.sendCard(
        msg.chatId,
        buildSystemNoticeCard({
          title: '⚠️ 指令执行出错',
          content: `执行指令 \`${matched.name}\` 时遇到内部错误：${err instanceof Error ? err.message : String(err)}`,
          template: 'red'
        })
      );
      return true;
    }
  }

  /**
   * 注册内置的核心基础指令
   */
  private registerBuiltinCommands(): void {
    // 1. /new 与 /reset: 新开对话与会话上下文重置
    this.register({
      name: '/new',
      aliases: ['/reset', '/clear', '新建会话', '开启新对话'],
      description: '重置当前上下文，并在 Finch 中开启全新的对话',
      usage: '/new [可选主题标题]',
      execute: async ({ msg, args, bridge, feishu }) => {
        const title = args.trim() ? args.trim() : undefined;
        const newSessionId = await bridge.createNewSession(msg.chatId, title);

        const summaryText = [
          '✨ **已为您开启全新对话！**',
          '',
          `> 🆔 **新会话 ID**: \`${newSessionId}\``,
          args.trim() ? `> 🏷️ **主题**: ${args.trim()}` : '> 🏷️ **主题**: 默认飞书对话',
          '',
          '_💡 上一个会话已在 Finch 中自动归档，之前的工程记忆已持久化。现在您可以轻装上阵，开始全新探讨！_'
        ].join('\n');

        await feishu.sendCard(
          msg.chatId,
          buildSystemNoticeCard({
            title: '✨ 会话已重置并开启新对话',
            content: summaryText,
            template: 'turquoise'
          })
        );
      }
    });

    // 2. /help: 帮助菜单与指令列表查看
    this.register({
      name: '/help',
      aliases: ['/h', '帮助', '指令'],
      description: '查看飞书机器人支持的所有快捷指令列表',
      usage: '/help',
      execute: async ({ msg, feishu, registry }) => {
        const lines: string[] = [
          '🤖 **Finch 飞书助手 · 快捷指令列表**',
          '',
          '你可以直接在输入框中发送以下指令，秒级执行、不消耗大模型 Token：',
          ''
        ];

        for (const cmd of registry.listCommands()) {
          const aliasStr = cmd.aliases && cmd.aliases.length > 0 ? ` _(别名: ${cmd.aliases.join(', ')})_` : '';
          const usageStr = cmd.usage ? `\n> 示例: \`${cmd.usage}\`` : '';
          lines.push(`• **\`${cmd.name}\`**${aliasStr}：${cmd.description}${usageStr}`);
        }

        lines.push('');
        lines.push('_💬 提示：未匹配任何指令的消息将自动交由 Finch Agent 智能分析与流式回复。_');

        await feishu.sendCard(
          msg.chatId,
          buildSystemNoticeCard({
            title: '📖 快捷指令帮助手册',
            content: lines.join('\n'),
            template: 'blue'
          })
        );
      }
    });
  }
}
