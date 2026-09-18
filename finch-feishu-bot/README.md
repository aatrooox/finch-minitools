# Finch 飞书机器人小程序 (finch-feishu-bot)

通过飞书官方 WebSocket 长连接（免公网 IP、免内网穿透），将飞书群聊 / 单聊消息无缝接入 Finch Agent，并通过飞书流式交互卡片实时呈现大模型打字机效果。

## 功能特性

- ⚡ **流式打字机卡片**：监听 Finch 的 `assistant.delta` 流式事件，实时刷新飞书卡片，支持 Markdown 渲染。
- 🔌 **免公网 IP 部署**：基于飞书官方 SDK 长连接（WebSocket）能力，桌面客户端直连飞书网关。
- 📬 **独立收件箱**：基于 Finch `sessionContainers`，外部飞书群聊或用户对话自动映射为独立的会话管理。
- 🔐 **系统级安全存储**：App ID 与 Secret 通过 macOS Keychain / 系统安全凭据隔离存储，拒绝明文泄露。
- ⚙️ **原生控制弹窗**：在 Finch 工具箱卡片或收件箱顶部，点击即可弹出原生表单配置与管理连接状态。

## 飞书开放平台配置说明

1. 登录 [飞书开放平台](https://open.feishu.cn/)，点击「创建企业自建应用」。
2. 进入应用管理后台：
   - **添加应用能力**：添加「机器人」能力。
   - **权限管理**：开通以下权限：
     - `im:message`（获取与发送单聊、群聊消息）
     - `im:message:send_as_bot`（以应用身份发消息）
     - `im:message.p2p_msg:readonly`（读取单聊消息）
     - `im:message.group_at_msg:readonly`（读取群聊中@机器人的消息）
   - **事件订阅**：
     - 事件监听方式选择：**长连接模式**（无需配置 Request URL）。
     - 添加事件：`接收消息 (im.message.receive_v1)`。
   - **发布版本**：创建版本并发布审核（企业内部应用通常秒过）。
3. 复制应用的 `App ID` 和 `App Secret`。

## 安装到 Finch

在当前工程根目录执行：

```bash
npx @finchtoys/minitools add .
```

安装完成后，在 Finch 的「小程序 / 工具箱」中启用「飞书机器人」，并在设置菜单中填入你的 `App ID` 和 `App Secret` 即可开始使用。
