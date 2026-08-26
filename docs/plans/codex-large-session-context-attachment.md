# Codex 大型 Session Context 附件化

## 目标

- 不再以 500 条 Session 作为 Codex 上下文选择上限。
- 避免大量 Session 引用直接拼进 `turn/start` 的文本 Prompt。
- 保持 ChatStore 只保存 Session 引用和注入 revision，不保存隐藏 Prompt 或附件正文。

## 设计对齐

- 当前 Codex Desktop 在粘贴文本达到 5,000 个 JavaScript 字符时转为文本附件；这是客户端策略，
  Codex App Server 官方协议没有声明自动转换阈值。
- 当前 App Server `v2.UserInput` 对本地文本文件使用 `mention` 输入项（`name + path`），没有通用
  `localFile` 文本输入项。
- 因此本 App 沿用 5,000 字符阈值：较小的 Session Context 保持原有内联行为；Codex 的较大
  Session Context 写入权限为 `0600` 的临时 `.txt`，通过 `mention` 随本轮提交，并在本轮结束后删除。
- Claude 路径保持原有内联行为；附件化只应用于 Codex。

## 观察点

- `turn/start.input` 同时包含精简文字指令和 `mention`，不再包含大型 Session Context 正文。
- 临时文件在 Provider Turn 运行期间存在，成功或失败后都被清理。
- 可选 Session 超过 500 条时 IPC 校验继续接受；每条 agent / id 仍执行原有严格校验。
- Chat 可见消息和 ChatStore 文件不出现隐藏 Prompt 或临时附件正文。

## 验证方式

- 单元测试覆盖 4,999 / 5,000 字符边界、Codex 附件内容与清理、Claude 内联回归。
- Codex Adapter 协议测试覆盖 `mention` 的 `name / path`。
- IPC Session 引用校验测试覆盖 1,000 条输入。
- Native Chat Controller 测试覆盖大型 Context 成功和失败后的临时文件清理。
- App 全量测试、production build 与 `git diff --check`。
