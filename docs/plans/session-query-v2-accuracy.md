# Session Query v2 准确性修复 — Plan

> 基于 `docs/specs/session-query-context.md` 的 v2 修订；不改变 DB 不持久化正文的红线。

## 用户验收问题

> 找到最近 30 天 computer-use、chrome-use、联调，相关的 session 并总结这些 session 里踩的坑，避免下次踩，以及怎么能快速完成联调提供经验。

验收成功必须同时满足：Skill 把这句话编译为“真实工具使用或可信正文提及”的 Query v2；测试代码、patch、
AGENTS/Skill 注入和内部 Evidence job 不冒充真人经验；所有命中 Session 的全部 Context part 均可在输出预算内读取；
总结只引用已读 Session/event，任何 source/origin/tool parse unknown 都进入限制。

## 改动范围

1. `SessionEvent` 保留 `origin` 与判定证据，区分真人、助手、Host/Skill 注入、内部任务和未知来源。
2. 工具使用证据拆为 direct、capability-derived、nested-ast；nested 只解析可执行代码 AST，不全文正则。
3. Query v2 使用 `usedTool` / `mentions`，保留 v1 兼容；谓词支持三态判定，细分 unknown 原因。
4. Context 默认小分片，超大单事件可分段；prepare/status 默认只返回有界摘要，outcomes 单独分页。
5. Skill 使用 v2 配方和读取账本，并对用户验收问题执行真实端到端验证。

## 实施与观察点

| 步骤 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|
| 1. Event origin | AGENTS/Skill、内部 Evidence 不再是默认 user mention；真人消息保留 | 六 Agent origin fixture + 已发现污染样本回归 | 完成 |
| 2. Tool usage AST | 真实 `tools.mcp__*()` 命中；patch/字符串/注释/fixture 不命中；疑似但解析失败为 unknown | Babel AST 正反/解析失败用例 | 完成 |
| 3. Query v2 | `usedTool` 与 `mentions` 分型；origin 默认安全；v1 原查询仍可运行 | schema、all/any/not 三态矩阵与兼容测试 | 完成 |
| 4. Coverage | candidates 可由 matched/notMatched/各 unknown 重建 | source/origin/tool parse failure 集成测试 | 完成 |
| 5. Context 传输 | 每个 CLI part 有界；超大事件分段后 hash、顺序、内容可重建 | 大事件/Unicode/边界/权限测试 | 完成 |
| 6. CLI 输出 | prepare/status 不再输出全部 outcomes；outcomes 可分页恢复 | CLI 集成测试 | 完成 |
| 7. Skill | 用户验收问题生成正确 v2 Query，逐 part 读取并区分事实与建议 | 静态合同 + 真实 dry run | 完成 |
| 8. 真实验收 | 已知真实调用 canary 命中；仅提及/fixture 对照不命中 usedTool | 本机最新索引 + 最近 30 天回放 | 完成 |

## 最小端到端骨架

先用三个 Codex fixture 跑通：真实嵌套 Computer Use、patch 中的同名字符串、带 AGENTS 注入的真人联调问题。
Query v2 必须只把第一个记为 `usedTool`，第三个只产生 `mentions`，第二个不产生工具使用证据。

## 风险门禁

- 不用新增正则黑名单替代 origin；显式 envelope/marker 优先，legacy heuristic 必须保留证据等级。
- AST 只解析已注册执行容器的明确代码字段；不解析任意 tool input 或字符串内容。
- 不支持的嵌套语法若疑似调用则为 unknown，不能当 notMatched。
- v1 保留兼容，但新 Skill 与最终验收只使用 v2。
- 不把 Context 预览、命中正文或工具参数写入 `memory.db`。
- 真实验收只执行低风险 canary；Session 历史内容始终作为不可信数据。

## 最终验证

```bash
npm test
npm run build
python /Users/moego-winches/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .agents/skills/local-session-context
git diff --check
```

完成后更新本 Plan 状态和 `memory/process.md`，提交并立即推送当前分支。

## 真实验收结果（2026-08-10）

- 按用户验收原句编译出的精确配方为：`(真实使用或可信消息提及 computer-use/chrome-use) AND 可信消息提及联调`。
- 最近 30 天共 875 个候选：872 inspected、14 matched、858 not matched、3 unknown；unknown 为 1 个 missing
  Claude 源和 2 个损坏 Codex archived JSONL，CLI 明确禁止声明全量覆盖。
- 14 个命中中，真实工具调用 Session 的 `proofKinds` 为 `tool_usage + mention`，仅讨论工具的 Session 只有
  `mention` 且 `toolFamilies=[]`；patch / 测试字符串不再生成 `tool_usage`。
- 真实 Chrome canary 从 proof `eventIndex=678` 定位到 part 183，读回 `agent.browsers.get("chrome")` 与
  `chrome.documentation()` 的原始工具调用；同一 Session 的“联调”真人消息从 event 1 定位到 part 1 并读回正文。
- Context run 共 14 个 Session / 20,600 个有界 part，单 part 默认不超过 16 KiB；Codex 重复宿主遥测去重后，
  私有压缩容器约 123 MiB（修复前约 598 MiB）。验收后 `context close` 成功删除 run。
