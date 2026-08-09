# live-session-evidence-evaluation — Plan

> 实现节奏 + 关键设计。完成后由 `flow-ship` 归档到 `docs/plans/done/`。
> spec：`docs/specs/live-session-evidence-evaluation.md`

## 目标

按 spec 建立 Host 主导的 Live Session Evidence Engine：完整枚举当前 Session Context selection，直接读取 6 类 Agent
权威来源，对源读取和模型处理分别记账，使用带 locator 的 Map-Reduce 生成结果，并由 Claim Gate 约束完整覆盖声明。随后用
固定脱敏 Benchmark 比较 v0-v3，最终接入可选的本地 Langfuse Reporter。

## 最小可验证链路

```bash
npm test -w @memory-manager/core -- --runInBand \
  packages/core/test/unit/evidence.test.ts \
  packages/core/test/unit/evidence-coverage.test.ts
```

期望行为：

```text
同一批 selected Session 全部产生唯一源终态；读取失败保留在 Ledger，complete 模式不会把 partial 结果声明为完整。
```

## 关键设计

- **行为**：Host 固定本轮 selected 范围，Reader 逐 Session 回源，Map 逐可读 Session 产出 Capsule，Reduce 只消费
  Capsule，Claim Gate 结合 Coverage 决定最终声明边界。
- **处理流程**：Session Context selection → Query Plan → Source Read → Normalize → Map → Reduce → Claim Gate →
  Native Chat 可见回答。
- **状态机**：每个 selected Session 先进入 visited，再进入 readable / empty / unavailable / failed；readable 再进入
  processed / failed。只有完整模式两层都无遗漏时，整轮状态才是 complete。
- **业务输入输出**：输入包含用户请求、selected references、模式和当前 Native Session；输出包含最终 Markdown、事实引用、
  Coverage 汇总、逐 Session 状态和限制。
- **模块间调用关系**：Core Scope/Reader/Ledger → App Evidence Runner → Provider Map jobs → 当前 Native Chat Reduce →
  Core Claim Gate → Renderer。
- **持久化边界**：临时正文和 Capsule 只存在于私有临时目录；`memory.db` 只保存运行 metadata；Langfuse 只接收脱敏
  Benchmark 和 allowlist Score/Trace 字段。

## Chunk 划分

### Chunk 1: Source Reader 与 Coverage 最小骨架

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 1.1 | 新增 Provider-neutral 读取结果和 Coverage 纯状态机，并让一个 JSONL Session 走通 selected → readable → processed → complete | 测试输出包含完整 Ledger，计数公式一致 | 新增 `evidence-coverage.test.ts`，先红后绿 | ✅ | 2026-08-09 |
| 1.2 | 把现有 6 Agent 回源逻辑收敛为逐 Session Reader 结果，错误不再只能打印后丢失 | missing、empty、格式错误均有稳定错误码和唯一终态 | 扩展 `evidence.test.ts` 与 `sessions` 定向测试 | ✅ | 2026-08-09 |
| 1.3 | 让旧 `extractEvidence` 通过兼容适配复用 Reader，同时保持 Rules Generation 的 Bundle、locator 和过滤语义 | 旧 Evidence 测试全绿，失败呈现边界明确 | Core Evidence/Rules 定向测试 + `git diff --check` | ✅ | 2026-08-09 |

**Observability Checkpoint**：

- **运行命令**：`npm test -w @memory-manager/core -- --runInBand packages/core/test/unit/evidence.test.ts packages/core/test/unit/evidence-coverage.test.ts`
- **期望输出关键字**：`PASS`，且测试断言 selected/source/processing accounting。
- **失败常见根因**：原 `extractEvidence` 依赖 grouped bundle；Copilot fallback 与 OpenCode SQLite 返回形态不同；
  source error 被兼容层提前吞掉。

### Chunk 2: 读取水位与临时 Evidence Context

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 2.1 | 为 JSONL 固定文件集合和字节水位，为 SQLite 使用短只读事务并记录变化指纹 | 运行中追加内容不混入本轮，变化计数可见 | 水位与 SQLite 变化 fixture 测试 | ✅ | 2026-08-09 |
| 2.2 | 扩展临时 Context writer，输出私有 manifest、chunks、coverage 和 capsules 目录 | 文件权限、chunk 顺序、locator 与 cleanup 可观察 | `evidence-context.test.ts` 权限/分片/清理测试 | ✅ | 2026-08-09 |
| 2.3 | 覆盖成功、Reader 失败、取消、owner PID 消失和 TTL 清理 | 临时目录没有泄漏，源文件未修改 | 中断/异常测试 + 临时目录前后对账 | ✅ | 2026-08-09 |

**Observability Checkpoint**：

- **运行命令**：`npm test -w @memory-manager/core -- --runInBand packages/core/test/unit/evidence-context.test.ts packages/core/test/unit/evidence.test.ts`
- **期望输出关键字**：`PASS`，变化场景出现 `changedDuringRun=true`，清理后临时目录不存在。
- **失败常见根因**：流式读取越过初始 byte boundary；SQLite 事务持有时间过长；异常分支未调用 cleanup。

### Chunk 3: Map-Reduce、Provider Runner 与 Claim Gate

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 3.1 | 打通单 Session 单 chunk 的 Map → Capsule → 当前 Chat Reduce → Claim Gate 端到端骨架 | 最终回答引用可解析 locator，Native handle 可继续 resume | Core/App 可控 Runner 集成测试 | ✅ | 2026-08-09 |
| 3.2 | 增加多 Session、多 chunk、分层 Reduce、有界并发和逐 Session processing accounting | 每个 readable Session 都 processed 或 processFailed | 10/151 Session 并发与失败注入测试 | ✅ | 2026-08-09 |
| 3.3 | 对齐 Claude、Codex、OpenCode 原生 Schema 与 Pi JSON+Zod fallback | 四 Provider 返回同一 Capsule/Reduce 错误合同 | 四个 Adapter 定向测试 | ✅ | 2026-08-09 |
| 3.4 | 完成 false-complete、未知 fact 引用、限制缺失和 secret leak Gate | partial/targeted 永远不出现完整声明 | Claim Gate 反向测试 + secret fixture | ✅ | 2026-08-09 |

**Observability Checkpoint**：

- **运行命令**：`npm test -w @memory-manager/core -- --runInBand packages/core/test/unit/evidence-coverage.test.ts && npm test -w @memory-manager/app -- --runInBand packages/app/test/native-chat-controller.test.ts packages/app/test/claude-chat-adapter.test.ts packages/app/test/codex-chat-adapter.test.ts packages/app/test/opencode-chat-adapter.test.ts packages/app/test/pi-chat-adapter.test.ts`
- **期望输出关键字**：全部 `PASS`；partial fixture 的回答包含限制且不含完整覆盖措辞。
- **失败常见根因**：Map 内部 Session 被误用为 Reduce 会话；Pi 非结构化结果没有进入统一解析；fact ID 在分层 Reduce 中丢失。

### Chunk 4: Native Chat 与 Renderer 产品链路

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 4.1 | 接入 auto / complete / targeted Query Plan，同时保持无 Session Context 的普通 Chat 零额外调用 | 集合级请求进入 complete，单点请求进入 targeted | Planner 中英文 query 表 + Controller 调用次数测试 | ✅ | 2026-08-09 |
| 4.2 | 把读取、处理、汇总、Gate 进度与 Coverage 结果送到 Renderer | UI 可见 n/N、partial 原因、changedDuringRun；取消终态随 4.3 生命周期语义验收 | IPC/type/i18n/layout 测试 | ✅ | 2026-08-09 |
| 4.3 | 让 interrupt 覆盖 Reader、Map、Reduce 和内部 Provider job，并保持 ChatStore revision/retry 语义 | 取消后无活跃 job、无临时目录、无伪完成消息 | Controller 中断测试 + ChatStore 回归 | ⏳ | —— |
| 4.4 | 排除当前 Native Session、Rules Generation 和内部 Evidence Session，阻止自我回灌 | 二次扫描后 selection 不新增内部会话 | scan/scope 集成测试 | ⏳ | —— |

**Observability Checkpoint**：

- **运行命令**：`npm test -w @memory-manager/app -- --runInBand packages/app/test/native-chat-controller.test.ts packages/app/test/session-context-prompt.test.ts packages/app/test/home-workflow-layout.test.ts`
- **期望输出关键字**：全部 `PASS`；完整、部分、目标检索和取消四种 UI 状态均有断言。
- **失败常见根因**：Session Context revision 只在成功后提交的旧合同被破坏；内部事件误追加为可见 Timeline；
  Renderer 自行推导 Coverage 导致状态漂移。

### Chunk 5: 固定 Benchmark 与版本比较

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 5.1 | 建立独立 eval workspace、脱敏 fixture manifest 和 v0-v3 Variant Runner | 同一 caseHash 可重复跑四个版本 | Runner 单元测试 + `--reporter none` smoke | ⏳ | —— |
| 5.2 | 实现 source/processing accounting、false claim、locator、secret 五个硬门禁 | 任一门禁失败时 exit code 非 0 | evaluator 反向 fixture | ⏳ | —— |
| 5.3 | 实现 relevant recall/precision、gold fact recall、support precision 和效率统计 | JSON report 分开显示门禁、质量、效率 | 10/151/500 案例运行与 schema 校验 | ⏳ | —— |
| 5.4 | 把 v0-v3 纳入可重复比较，确认 v3 过全部门禁且质量不低于目标阈值 | 报告可逐 case 定位回归，不生成单一总分 | 全 Benchmark 命令 + 基线对比 | ⏳ | —— |

**Observability Checkpoint**：

- **运行命令**：`npm run eval:session-evidence -w @memory-manager/evals -- --variant v3-map-reduce --reporter none`
- **期望输出关键字**：`hard_gates=pass`、`cases=`、`variant=v3-map-reduce`，exit code 0。
- **失败常见根因**：fixture 混入真实 Session；caseHash 不稳定；质量退化被总分掩盖；门禁失败仍返回 0。

### Chunk 6: 可选本地 Langfuse Reporter

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 6.1 | 在 eval workspace 增加 Reporter 接口与 Langfuse 实现，生产 Core/App 不引入 SDK | dependency 只存在于 eval package | workspace dependency 与 bundle 检查 | ⏳ | —— |
| 6.2 | 映射 Dataset Item、Experiment、Trace/Span 和 Score，并校验本地 caseHash | Langfuse UI 可比较同一 Dataset 的 v0-v3 | 本地 Docker Langfuse smoke + API readback | ⏳ | —— |
| 6.3 | 对 Reporter payload 使用字段 allowlist，并隔离不可达、鉴权和 flush 失败 | payload 无原文/Prompt/Tool output，上报失败不损坏本地报告 | payload snapshot + 网络失败测试 | ⏳ | —— |

**Observability Checkpoint**：

- **运行命令**：`LANGFUSE_BASE_URL=http://localhost:3000 npm run eval:session-evidence -w @memory-manager/evals -- --variant v3-map-reduce --reporter langfuse`
- **期望输出关键字**：`reporter=langfuse`、实验 URL 或 run id；Langfuse 不可用时明确 `reporter_failed`。
- **失败常见根因**：本地 Dataset hash 与平台最新版本不一致；SDK flush 未等待；Trace input/output 默认采集了敏感字段。

### Chunk 7: 完整回归与真实验收

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 7.1 | 完成 Core/App/evals 全量测试与 production build，修复所有新增回归 | 所有 suite 0 failed、0 skipped，构建无新增 warning | 全量命令 + `git diff --check` | ⏳ | —— |
| 7.2 | 使用隔离 HOME 做 Electron 完整/部分/变化/取消视觉与生命周期 smoke | UI 与 Coverage 一致，主应用数据不变 | production Electron 实测记录 | ⏳ | —— |
| 7.3 | 对照 spec 逐项完成 completion audit，更新 `memory/process.md` 和 plan reviewed/决策记录 | spec 每项有代码、测试或实测证据 | 文件/命令/运行结果 Coverage Ledger | ⏳ | —— |
| 7.4 | 按仓库规则完成最终 commit/push，并确认本地与 `origin/main` SHA 一致 | 工作树干净，远端包含最终提交 | Git SHA 对账 | ⏳ | —— |

**Observability Checkpoint**：

- **运行命令**：`npm test -w @memory-manager/core && npm test -w @memory-manager/app && npm run build -w @memory-manager/core && npm run build -w @memory-manager/app && npm run eval:session-evidence -w @memory-manager/evals -- --variant v3-map-reduce --reporter none && git diff --check`
- **期望输出关键字**：所有测试/构建成功，Benchmark `hard_gates=pass`，工作树只包含预期改动。
- **失败常见根因**：定向测试未覆盖跨模块合同；真实 Provider 生命周期与 mock 不一致；文档、plan、代码和评测 Variant 漂移。

## 风险点 + 兜底

- Host 已读但模型未处理 —— Source 与 Processing 两层 Ledger 分开记账，Claim Gate 同时校验。
- 大规模 Session 成本/延迟失控 —— 有界分片、并发、取消和分层 Reduce；效率优化不绕过硬门禁。
- 动态来源破坏一致性 —— 固定 JSONL 水位和 SQLite 短读事务，变化通过 `changedDuringRun` 披露。
- 历史 Prompt injection 被执行 —— Evidence job 最小工具权限，历史内容始终作为不可信数据。
- 内部 Provider Session 自我回灌 —— host marker、native handle metadata 和 Scope 排除共同兜底。
- Pi 缺少原生 Schema —— JSON + Zod + 有界重试必须实测；无法满足时先补 Adapter 能力，不降低合同。
- Langfuse 泄漏或不可用 —— 默认 Reporter none、payload allowlist、本地结果真理来源、生产包零 SDK 依赖。

## 验收

```bash
npm test -w @memory-manager/core
npm test -w @memory-manager/app
npm run build -w @memory-manager/core
npm run build -w @memory-manager/app
npm run eval:session-evidence -w @memory-manager/evals -- \
  --variant v3-map-reduce --reporter none
git diff --check
```

必须证明：

1. selected Session 全部进入唯一源终态，complete 模式全部 readable Session 进入唯一处理终态。
2. unavailable/readFailed/processFailed 不会被静默丢弃，partial/targeted 不出现虚假完整声明。
3. locator 100% 可回固定 fixture，历史 Prompt injection 不触发写操作或外部工具。
4. JSONL/SQLite 运行中变化被记录且不改变本轮读取边界。
5. Native Chat 的 revision、resume、Provider lock、interrupt、Timeline 和 ChatStore 行为不回归。
6. Rules Generation、`sessions show --stream` 和 6 Agent 现有读取语义不回归。
7. DB schema 不变，DB/ChatStore/eval report/Langfuse payload 不保存禁止内容。
8. v3 通过全部硬门禁，质量和效率按独立维度可与 v0-v2 比较。
9. 本地 Langfuse 可选；关闭或不可达时生产功能与本地评测仍可用。
10. 本机 Electron smoke、全量测试、构建、Benchmark 和 Git 远端对账全部完成。

## 非目标

本 plan 不实现 RAG、向量索引、知识图谱、持久化 Session 快照、Langfuse Cloud 默认上报或数据库内容仓库；不借本功能
重构无关的 Provider UI、项目分类和 Rules 产品流程。

## 决策记录（活更新，Y-only）

每步完成时更新状态和 reviewed 日期；仅在发现会影响后续步骤时追加决策段。
