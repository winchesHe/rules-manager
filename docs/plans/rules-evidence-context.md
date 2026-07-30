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
  的多回合。当前 inference gateway 对 SDK `outputFormat: json_schema` 稳定返回
  502，因此 Claude 使用 YAML block scalar 输出并在本地做 YAML + Zod 校验。
- Codex 使用 `-C <evidence-dir>`、read-only sandbox 和 `--output-schema`。
- Provider 最终结果仍经过本地 Zod 校验。

观察点：

- Chat 流式出现真实 Read / Search / Thinking Activity。
- Claude / Codex 的初始 stdin/prompt 不包含 Evidence 正文；只携带体积固定的输出结构
  契约和 Evidence Context 路径。
- Codex 格式由 Provider 原生 Schema 约束；Claude 使用短 YAML 契约与本地 Zod 校验。

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

## 选择性读取修正（2026-07-30）

真实 Recent activity 验证发现，“Evidence 完整落临时文件”与“Agent 必须读取全部
batch”仍会在 Read tool result 中重新形成大上下文。完整收集不再等价于模型全量加载。

观察点：

- Agent 只先读取 `manifest.json`，随后以 Glob / Grep 搜索明确要求、纠正、稳定偏好
  和跨 Session 重复信号。
- Read 只用于命中位置附近的 Evidence block，不允许按顺序遍历或完整读取全部 batch。
- 单个 Project 最多 32 turns；真实验证表明 16 turns 会在多组选择性 Grep 后来不及
  生成结果。是否全量读取由 Prompt 禁令约束，turns 只提供完成分析和输出的预算。
- 全部脱敏 Evidence 仍完整保存在 Context 文件，数据库和初始 Prompt 仍不含原文。

验证方式：

- Rule Generate 单元测试禁止 Prompt 出现“读取全部文件/完成全部 batch 阅读”，并断言
  Prompt 明确要求 Grep-first、按需 Read 和禁止全量读取。
- 单元测试断言 Provider context 的 `maxTurns` 固定为 32。
- 使用与失败 Run 相同的 Recent activity cutoff 做真实 Claude dry-run，确认出现真实
  Search / Read / Thinking Activity，并记录 Provider 最终结果和临时目录清理。

实现过程中补充发现并修正：

- Rules Generation 的 Claude Provider Session 会被后续 Scan 再次分类，旧实现因此把
  上一轮完整 Prompt + Evidence 当作新 Evidence，形成自我回灌。现在只要 Session
  含 Rules Generation 内部 Prompt 签名，就整段排除，不让其 Prompt 或输出进入下一轮。
- `agent-rules-manager` 的真实 Evidence 因此从约 14.4 MB / 52 excerpts 降为约
  2 KB / 10 excerpts（不同 cutoff 下为 58 bytes / 2 excerpts）；超大内容实际均为
  内部 Provider Prompt，而非用户对话。
- 同一 SDK/网关的极短对照实验：启用原生 JSON Schema 时约 3 分钟后 502；移除
  `outputFormat` 后 3.2 秒返回 `OK`，确认是网关兼容性而非 Evidence 或认证问题。
- Claude 手写 JSON 曾因规则正文包含未转义 ASCII 双引号而失败，改为 YAML block
  scalar 后可稳定保留正文，再由本地 Zod 校验为候选数组。
- 真实复测：`agent-rules-manager` 65 秒完成并返回 0 条候选；Recent 最大项目
  `agent-workspace` 选择性读取约 1.27 MB Evidence 后返回 8 条候选；
  `ai-guanglinglu` 返回 10 条候选。三者均出现 Thinking / Search / Read，未再出现
  502、Prompt too long、max-turns 或结构化解析失败。
