# Chat Assistant 时间线顺序修复

## 改动范围

- 将 Native Chat 单轮输出从“整段 Assistant 正文 + 独立 Tool 列表”升级为按首次出现顺序保存的
  `assistant / thinking / tool` timeline。
- Codex 与 Claude Adapter 为正文增量提供稳定 item ID，并接入 Provider 明确输出的 reasoning / thinking
  增量；Tool 状态更新只更新原位置。
- Main Controller 使用同一 reducer 驱动实时 IPC 与最终持久化，Renderer 使用同一顺序渲染实时和历史消息。
- 保留 `content / toolActivities` 兼容字段；没有 timeline 的旧消息按“Tool → 最终正文”展示，避免结论先于执行过程。

## 观察点

1. `assistant A → tool 1 → assistant B → tool 2 → assistant C` 在实时和刷新后顺序一致。
2. 同一个 Tool 的 running / completed 更新不重复，也不移动位置。
3. thinking / reasoning 出现在相邻 Tool 之间，可展开查看正文，不与最终结论拼接。
4. 旧 JSONL 不迁移、不损坏；仍可读取 Tool 详情，且最终结论位于旧 Tool 列表之后。
5. Chat 文件仍不保存 Tool output、原始 Tool input、隐藏 Prompt 或 Session 原文。

## 验证方式

- Adapter 单元测试覆盖 Codex 与 Claude 的交错正文、thinking、Tool 事件及 item ID。
- Controller / Store 单元测试覆盖 timeline 合并、持久化、旧消息兼容和 Tool 定位。
- Renderer model / 静态契约测试覆盖 timeline 顺序与 legacy fallback。
- 执行 App/Core 全量测试、production build、`git diff --check`。
- 在 production Electron 中发起包含多次 Tool 调用和中间说明的真实对话，刷新后复验顺序与展开行为。
