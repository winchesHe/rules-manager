# memory-manager 实施计划索引

本文档索引把 `docs/specs/memory-manager-spec.md` 中的总设计拆成多个可实施 plan。所有 plan 遵循同一原则：

```text
最小可验证链路 -> 渐进增强
```

每个阶段都必须能独立验证，不依赖一次性 big-bang 实现。

## 计划顺序

| 顺序 | Plan | 目标 |
| --- | --- | --- |
| 1 | [Workspace & State](./01-workspace-state.md) | 建立最小工作区、配置与 SQLite 状态库 |
| 2 | [Scan & Sources](./02-scan-sources.md) | 支持内置 agent/custom source 的扫描入口 |
| 3 | [Agent Adapters](./03-agent-adapters.md) | 基于真实 `test/sources` 实现 4 个 adapter |
| 4 | [Project Classification](./04-project-classification.md) | 把真实 source 准确分类到预期项目 |
| 5 | [LLM Rule Generation](./05-llm-rule-generation.md) | 通过 `pi-code-agent` SDK 生成候选 rules |
| 6 | [Confidence & Review](./06-confidence-review.md) | 为候选 rules 评分，并支持人工 accept/reject |
| 7 | [Renderer & Outputs](./07-renderer-outputs.md) | 输出正式 Markdown rules |
| 8 | [Safety & Validation](./08-safety-validation.md) | 补齐安全、dry-run、mock LLM 和端到端验收 |

## 端到端验收链路

完整 MVP 最终需要通过：

```bash
memory-manager init --non-interactive
memory-manager scan --source test/sources --all
memory-manager projects list
memory-manager rules generate --dry-run
memory-manager rules generate
memory-manager rules show --project Boarding_Desktop
memory-manager rules show --global
memory-manager rules show --style
```

必须证明：

1. 4 个真实 source 被发现。
2. 4 个 agent 分类准确。
3. DB 不保存完整 session content。
4. rules 生成经过 `pi-code-agent` SDK。
5. 正式 Markdown 只包含 `high` 和 `verified` rules。
6. P0-P6 只用于最终 Markdown 文案优化。
