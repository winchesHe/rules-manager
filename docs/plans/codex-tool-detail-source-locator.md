# Codex 工具详情 Source Locator 修复

## 改动范围

- Memory Manager 继续只持久化工具摘要与原生定位信息，不复制保存完整 tool output。
- 新产生的 Codex Tool Activity 保存 `turnId + toolIndex`，作为稳定 source locator。
- 展开工具详情时，优先保留现有 `thread/read + itemId` 路径；无法命中时按 locator 从 Codex 原始
  Session JSONL 读取对应 `custom_tool_call / custom_tool_call_output`。
- 旧 Chat 没有 locator 时，根据 Assistant 轮次和该轮工具序号生成兼容 locator，使现有历史会话可读。
- 找不到 Session、轮次、工具或 output 时继续返回 `available: false`，不得误配其他命令输出。

## 观察点

1. 截图会话的首条 Command 可以展开，读取到 RTK 与 flow-brainstorm 的真实原生输出。
2. Memory Manager 的 `messages.jsonl` 仍不包含完整工具输出，只新增无正文 locator。
3. 同一轮多个工具、跨多轮工具均按各自顺序准确关联；分页读取行为保持不变。
4. Claude 和现有 Codex `thread/read` 命中路径不回归。

## 验证方式

- Codex Adapter 单测覆盖：直接 ID 命中、source locator JSONL 回退、旧轮次 locator、缺失与分页。
- Native Chat Controller 单测覆盖：从持久化消息解析新旧 locator，并拒绝未授权 item。
- 使用本机截图对应的真实 Session 做只读定向验证，确认原始 output 可恢复。
- App/Core 全量测试、production build、`git diff --check`。
