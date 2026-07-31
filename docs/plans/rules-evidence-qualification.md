# Rules Evidence 资格与既有规则去重

## 范围

- 区分真实用户规则信号、Assistant 上下文和平台注入上下文。
- 平台注入的 `AGENTS.md` / `CLAUDE.md` 指令不再作为 Evidence；其中的既有规则作为临时 Baseline 提供给生成 Agent 去重。
- Candidate 必须引用至少一条真实用户信号；与 Baseline 等价的规则不进入 Draft。
- 不改变 Candidate 数据结构，不保存 Session 原文、注入 Prompt 或 Baseline。

## 验收标准

- Codex 注入的 `# AGENTS.md instructions ... <INSTRUCTIONS>` 不出现在 Evidence batch 中。
- Assistant 对既有规则的复述可以保留为理解上下文，但不能单独支撑 Candidate，也不参与 frequency。
- 用户后续明确提出或纠正的规则仍能生成。
- 与现有 AGENTS/引用规则等价的 Candidate 在展示和持久化前被过滤。
- Core 全量测试、构建与真实 dry-run 通过。

## Step 1：建立 Evidence 资格边界

只增加失败测试，覆盖平台注入过滤、Baseline 提取、Assistant context-only 和真实用户信号。

- 观察点：新增测试在实现前失败，失败原因明确指向缺少资格字段或注入过滤。
- 验证方式：单独运行 `evidence.test.ts`。

## Step 2：把资格与 Baseline 写入临时 Context

Evidence batch 标注 `evidence_kind`；Baseline 单独写入 `baseline.md`，manifest 只记录路径与大小。

- 观察点：batch 仍保留完整 user / assistant 对话，但不包含注入正文；Baseline 与 Evidence 分离。
- 验证方式：单独运行 `evidence-context.test.ts` 并检查临时文件断言。

## Step 3：在 Candidate 边界做本地强校验

Provider 返回后，过滤没有真实用户引用的 Candidate，以及与 Baseline 明显等价的 Candidate。

- 观察点：合法的新规则保留；Assistant-only、伪造引用和既有规则重复项消失。
- 验证方式：单独运行 `rule-candidates-generate.test.ts`。

## Step 4：同步上下文并完成回归

更新 `memory/process.md`，执行 Core 全量测试、构建和真实 Recent activity dry-run。

- 观察点：真实生成中不再出现来自 AGENTS/RTK 的重复规则，用户后续明确纠正仍有资格。
- 验证方式：全量测试与构建通过；检查 dry-run 输出和 Chat activity。

## 完成记录

- Step 1–3 已完成：注入过滤、Evidence 资格、Baseline Context 和 Candidate 本地强校验均有回归测试。
- 最近 7 天真实 `agent-workspace` 对账：32 个选中 Session 中 31 个可读，形成 417 条 `user_signal`、1,919 条 `assistant_context` 和 2 个 Baseline source；Evidence 中不再包含 `# AGENTS.md instructions`，中文回复与 RTK 规则均只进入 Baseline。
- Provider 全历史压力验证可完成 310 个 Session 的收集并形成 35,110 excerpts / 36 batches，没有出现大 Prompt、retry 或 too-long；因 Claude 长时间未返回最终结构化结果，手动取消 dry-run，未写数据库。
