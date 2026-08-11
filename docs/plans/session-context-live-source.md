# Session Context 实时回源与临时清理 — Plan

## 目标

将 `context prepare` 从“命中 Session 完整正文快照”改为“轻量查询结果 manifest”。后续 `read` 与 `locate`
按 Session ID 重新读取当前最新权威源，并重新判断原 Query 的内容谓词。正文不进入 `memory.db`，也不写入系统
临时目录；只保留 coverage、outcome、proof、查询时间和准备时 source revision。

同时修复 App scan-history 测试创建临时 SQLite 后不删除的问题，并提供显式过期 run 清理入口，清除本机已遗留的
旧 context run 与测试数据库。

## 设计边界

- `scan --all` 仍负责更新 Session 元数据索引；Query 候选仍来自 `memory.db`。
- `prepare` 逐个回源判定，但最终只保存 matched outcome 的轻量字段与 proof，不保存事件正文、工具输出或媒体。
- `sessions` 返回准备时事件数和 proof 摘要，不再承诺或返回准备时 `partCount`。
- `read` 每次回源读取最新事件、重新判断原 Query 的内容谓词，并按当前事件流计算 part；返回当前 selection 状态、是否相对
  prepare 发生源变化、当前 source revision 和读取时间。
- `locate` 优先用 prepare proof 的稳定 `sourceLocator` 在最新事件流中重新定位，再计算当前 part 邻域；定位不到
  时明确报错，禁止退回陈旧 event index 冒充当前位置。
- 允许 Session 在 prepare 后追加或改写；变化是信息，不再是“必须使用冻结水位”的限制。
- 最近 7 天完整读取仍可能占用大量模型上下文；本轮只消除磁盘正文快照，不把“完整读取”伪装成低成本操作。

## 实施与验证

| 阶段 | 观察点 | 验证方式 |
|---|---|---|
| 1. 轻量 run | run 目录只有私有 `owner.json` 与 `manifest.json`，不存在 `sessions/` 或正文片段 | Core unit + CLI integration |
| 2. 最新回源 | prepare 后追加源事件，`read` 能读到新增内容并报告 source changed | CLI integration fixture |
| 3. 当前定位 | `locate` 用 sourceLocator 映射到最新 event/part；锚点消失时明确失败 | Core unit |
| 4. 内容谓词重判 | 最新源不再匹配时返回 `selectionChanged=true` 与当前状态，不声称仍相关 | Core unit |
| 5. 清理 | scan-history 测试运行后不遗留临时 DB；显式 cleanup 仅删除已过期且可验证的 context run | App/Core unit |
| 6. Skill | Skill 不再要求固定水位或 close 临时正文，按最新源和证据邻域读取 | 静态合同 + validator |
| 7. 全量回归 | Core/App 全量测试、build、TypeScript、diff check | 仓库命令 |
| 8. 真实环境 | 旧 run 与测试 DB 清空；一次真实 prepare 不生成 `.parts.gz` | 目录审计 + CLI dry run |

## 验收标准

1. `context prepare` 命中任意 Session 后，临时 run 中没有 Session 正文或 gzip 文件。
2. prepare 后修改原 Session，`context read` 返回修改后的最新内容。
3. `read` 重新判定 Query，并显式报告 selection/source 是否变化。
4. `sessions / outcomes / proofs` 继续完整分页，coverage 账本保持不变。
5. 旧 context 快照与 `memory-manager-scan-history-*` 测试数据库已清理，重新跑测试不再产生泄漏。
6. `local-session-context` Skill、CLI reference、Spec、测试和真实行为一致。
