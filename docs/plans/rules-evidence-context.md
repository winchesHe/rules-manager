# Rules Evidence Context 实施计划

日期：2026-07-30

## 已确认语义

- Recent activity 只选择 `sessions.updated_at >= now - 7 days` 且非 missing 的
  Session；不得再从最近 Scan 的 new / updated 记录反推。
- JSONL Agent 的 `updated_at` 必须代表最后一次源文件活动，而不是 Session 首条
  metadata 的创建时间；Claude 多文件 Session 取全部 JSONL 的最大 mtime。
- Session 一旦被选中，默认读取全部 user / assistant 消息。`rounds` 只保留为
  CLI 显式覆盖，不再是 APP 默认值。
- Select projects 读取目标 Project 的全部 Session 与完整消息；Full history
  读取全部 Session 与完整消息。
- Evidence 不再序列化进初始 Prompt，而是写入 Run 级临时上下文，由 Agent 使用
  Read / Grep / Glob 渐进读取。
- Candidate 继续只在整个 Run completed 后一次性展示。

## 步骤 1：锁定 Session 与消息选择语义

只修改 Evidence 的输入边界，不改变 Provider 调用。

观察点：

- 最近 7 天的筛选依赖 Session 自身 `updated_at`。
- 重复 Scan 不会让旧 Session 进入 Recent activity。
- 默认 Evidence 包含选中 Session 的第一条到最后一条消息。

验证方式：

- Evidence 单元测试覆盖 cutoff 前、等于 cutoff、cutoff 后和 missing Session。
- 将默认 35 条消息 fixture 的期望从 30 条改为 35 条。
- Worker 契约测试禁止 `listChangedSessionIds` 参与 Rules Generation。

## 步骤 2：搭出临时 Evidence Context 最小骨架

每个 Run 创建权限为 `0700` 的临时目录；每个 Project 写 manifest 和按字节预算
切分的 Markdown batch。完整 excerpt 文本、locator、role、frequency 和工具摘要
均保留，单条长文本只跨行展示，不做截断。

观察点：

- 初始 Prompt 只有任务、manifest 路径与输出约束，不包含 Evidence 正文。
- Project 的全部 excerpt 能从 batch 文件恢复。
- 多 Project 使用独立目录，slug 不直接作为文件路径。
- JSONL 原文逐行流式解析，不再通过 `sessions show` 的 50 MiB 一次性输出上限。

验证方式：

- 单元测试检查 manifest、batch 边界、完整正文和目录权限。
- Rule Generate 测试断言 Provider Prompt 不含 Evidence 原文。

## 步骤 3：Agent 渐进读取与原生结构化输出

- Claude 使用 Evidence 目录作为 `cwd`，只开放 Read / Grep / Glob，允许受预算约束
  的多回合，并使用 SDK `outputFormat: json_schema`。
- Codex 使用 `-C <evidence-dir>`、read-only sandbox 和 `--output-schema`。
- Provider 最终结果仍经过本地 Zod 校验。

观察点：

- Chat 流式出现真实 Read / Search / Thinking Activity。
- Claude / Codex 的初始 stdin/prompt 不包含 JSON Schema 全文或 Evidence 正文。
- 格式正确性由 Provider 原生 Schema 约束，不再靠提示词反复要求“只输出 JSON”。

验证方式：

- LLM 单元测试检查 Claude options 与 Codex args。
- 使用包含真实 Read Activity 的 provider fixture 验证事件链。

## 步骤 4：失败分类与清理

观察点：

- `Prompt is too long`、结构化输出耗尽和 max turns 属于确定性失败，不原样重试。
- 只有瞬时 Provider 错误允许有限重试。
- completed / cancelled / failed 均清理临时 Evidence；进程异常遗留在下次启动清理。

验证方式：

- 单元测试覆盖非重试错误、瞬时错误、取消和异常清理。
- 检查 Chat 不持久化 Evidence 正文或临时路径以外的 tool output。

## 步骤 5：端到端验收

观察点：

- 真实 Recent activity 的 Session 集合与 DB `updated_at` cutoff 查询一致。
- 最大 Project 能通过文件读取完成生成，不再出现初始 Prompt too long 风暴。
- Rules 仍只在 completed 后一次性出现。

验证方式：

- Core / APP 全量测试。
- Core / Electron production build。
- 使用隔离工作区执行大 Evidence dry-run，记录 Session、excerpt、batch、Activity 与
  临时目录清理结果。
- `git diff --check`，同步 `memory/process.md` 后提交。

## 验收记录

- 最大真实 Project `agent-workspace`：310 个索引 Session 中 245 个存在可读对话；
  共读取 36,074 条 user / assistant 消息，形成 35,453 个 Evidence excerpt 和
  35 个约 512 KiB batch，约 11 秒完成 Context 创建与清理。
- 原 50 MiB 限制下同一 Project 只能纳入 239 个 Session、20,447 条消息；改为逐行
  解析后不再跳过大文件。Copilot 只有 metadata、源端没有正文的 Session 仍按事实
  记录并跳过。
- 真实 Claude 调用确认初始 Prompt 不含 Evidence，Agent cwd 指向临时 Project
  Context，开放 Read / Grep / Glob，并只发起单次调用；本次上游最终返回 502，
  没有再次长时间 retry，失败后临时目录已清理。
