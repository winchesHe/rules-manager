# Chat 运行中对话终止按钮修复

## 改动范围

- Native Chat Composer 的「停止本轮」按钮同时识别本地发送状态与已持久化的 Thread 运行状态。
- 覆盖从 Rules 发起后跳转到 Chat、切换回运行中对话、刷新后恢复运行中对话三类入口。
- 继续复用现有 `chat.interrupt`，不修改 Provider 中断协议、消息队列或 Rules Generation 顶部操作。

## 观察点

- `isSending=true` 的 ChatView 本地发送过程仍显示终止按钮。
- `thread.kind=native-chat && thread.status=running` 时，即使 `isSending=false` 也显示终止按钮。
- ready / failed / interrupted 的 Native Chat，以及 rules-generation Thread，不因本次改动显示 Composer 终止按钮。

## 验证方式

- 为统一运行态判定增加单元测试，覆盖本地发送、Rules 跳转恢复、终态与非 Native Thread。
- Composer 布局契约验证终止按钮使用统一判定。
- 运行 App 定向测试、App 全量测试、production build 与 `git diff --check`。
- 在真实 Electron 中从 Rules 发起生成并确认运行中 Composer 显示「停止本轮」。
