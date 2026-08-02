# Chat Native Turn 渲染修复

## 改动范围

- Native Chat 发送后立即刷新已持久化的用户消息，不等待 Provider 完成。
- 运行中的 Assistant 区域从本轮用户消息时间开始展示递增耗时；完成后保存并展示真实起止耗时。
- Codex item 生命周期只投影真实工具/思考活动，过滤 `userMessage`、`agentMessage` 等消息 item。
- Renderer 使用本轮累计正文快照更新流式内容，避免同一 IPC 事件重复投递时把增量重复拼接。
- 已有 `createdAt === completedAt` 的历史 Assistant 消息，展示时回退到其前一条用户消息作为本轮开始时间。

## 观察点

1. 新建对话点击发送后，在首个 Provider delta 前即可看到用户气泡和从 `0s` 开始递增的计时器。
2. Codex 流式正文不再出现逐块重复；完成后的持久化正文与流式最终正文一致。
3. `userMessage` / `agentMessage` 不再出现在 Tool Activity 列表，Command 等真实工具仍正常显示。
4. 完成态 Footer 展示本轮实际耗时，旧历史会话也不再因 Assistant 自身时间戳相同而固定为 `0s`。

## 验证方式

- Adapter 单测：消息 item 被过滤，Command item 保留。
- Controller 单测：用户消息落盘后立即触发刷新；流式事件包含累计正文；Assistant 保存真实 `createdAt / completedAt`。
- View Model / Renderer 契约测试：旧消息耗时回退和运行中计时器接线。
- `npm test`、`npm run build`、`git diff --check` 全量验证。
