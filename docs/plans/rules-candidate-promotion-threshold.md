# Rules 候选晋级硬门槛

日期：2026-08-10

## 范围与验收标准

- 只收紧之后新生成的候选；不追溯删除或改写已有 Draft、Accepted 或 Rejected 规则。
- Provider 的 `high / medium` 只表达证据强弱，不能绕过 Host 资格校验。
- 候选至少满足以下一项才允许进入 Draft：
  1. 同一候选引用至少两个不同 Session 的真实 `user_signal`；
  2. 同一候选引用至少两条独立、明确的用户纠正；允许发生在同一 Session，但 locator 必须不同；
  3. 至少一条真实 `user_signal` 明确要求 Agent 记住、写入规则或以后持续遵循。
- 单次普通要求、单次禁止、单次纠正、Assistant 复述、无效 locator、重复引用同一个 locator，均不得晋级。
- 语义是否支持同一候选继续由 Provider 结合上下文判断；Host 负责验证引用确实属于本轮真实用户证据，并执行上述可确定的数量和意图门禁。
- Scope、Baseline 去重、low 过滤、Evidence 隐私和多项目失败隔离保持不变。

## Step 1 · Prompt 收紧

- 在完整读取和选择性检索两类 Prompt 中使用同一套候选晋级门槛。
- 明确要求 `evidence_refs` 引用全部用于晋级的独立 locator，并在 reasoning 中说明命中哪一类门槛。
- 明确单次普通要求即使措辞强烈或被判为 high，也不能生成候选。

验证方式：扩展 `rule-candidates-generate.test.ts`，断言 Prompt 同时包含三类门槛与单次信号禁令。

## Step 2 · Host 资格门禁

- 对 Provider 返回的 `evidence_refs` 解析并按 `{sessionId,messageIndex}` 去重。
- 跨 Session 重复按 distinct Session 数量判断。
- 重复纠正按不同 locator 中的明确中英文纠正表达判断。
- 明确记忆按中英文“记住 / 写入规则或记忆 / from now on”等持久化表达判断。
- 任一门槛命中后再执行既有 Scope 规范化与 Baseline 去重。

验证方式：覆盖跨 Session 通过、同 Session 普通重复失败、重复纠正通过、单次纠正失败、明确记住通过，以及重复 ref 不可绕过。

## Step 3 · 回归与交付

- 运行 Core 定向测试与全量测试、Core/App production build、`git diff --check`。
- 同步 `memory/process.md`，记录门槛、边界和验证结果。
- 按仓库规则 commit 并立即 push 当前分支。

