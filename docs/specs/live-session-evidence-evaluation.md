# Live Session Evidence 与评测闭环

## 概述

当前 Native Chat 的 Session Context 只向 Provider 注入选中的 Session ID 和
`memory-manager sessions show <id> --stream` 命令。Host 没有替 Provider 执行完整读取，也没有记录每个
Session 是否被访问、是否可读、是否进入总结。因此，模型即使只抽样读取少量 Session，也可能在最终回答中声称
“已经总结全部 Session”。

本功能把跨 Session 总结从“Prompt 约定”升级为 Host 主导的 **Live Session Evidence Engine**：在任务执行时直接读取
6 类 Agent 的本地权威来源，对所有选中 Session 建立可审计的 Coverage Ledger，按受控批次完成 Map-Reduce，最后由
Claim Gate 决定回答能否声称完整覆盖。同时建立固定、脱敏、可重复的评测集，并以本地 Langfuse 作为可选的实验账本和
可视化后台。

核心目标：

1. 对需要集合级结论的 Session Context 请求，Host 必须实际访问选中的完整 Session 集合，而不是把 ID 列表交给模型自行抽样。
2. 区分“源数据已读”和“内容已进入模型处理”：同时记录 `readable` 与 `processed`，失败不能静默跳过。
3. 每个总结事实必须可以回到 Session、Agent 和原始消息位置；历史内容只能作为不可信证据，不能成为当前指令。
4. 对大规模 Session 使用有边界的 Map-Reduce，在上下文和成本可控的前提下保持覆盖诚实。
5. 使用固定脱敏 Benchmark 比较 Prompt-only、Host 直读、Coverage 和 Map-Reduce 版本，先过硬门禁，再比较质量与效率。
6. Langfuse 仅作为可选评测出口；关闭 Langfuse 时，生产读取、总结和本地评测仍完整可用。

## 非目标

本阶段不做以下能力：

1. 不建设 RAG、Embedding、向量数据库或持久化语义索引。
2. 不建设 Session → Repo → PR → Issue 的知识图谱。
3. 不把 Session 原文、Tool output、完整 LLM Prompt 或中间模型输出写入 `memory.db`。
4. 不建立持久化 Session 快照目录，也不把动态 Session 复制成长期内容仓库。
5. 不让 Langfuse 参与生产查询规划、源读取、Coverage 判断或 Claim Gate。
6. 不默认向 Langfuse Cloud 上传真实 Session；MVP 只支持本地 Langfuse 或禁用 Reporter。
7. 不用单一加权总分掩盖覆盖失败、虚假完整声明或敏感信息泄漏。
8. 不在本功能中重做现有 Session 扫描、项目分类、ChatStore 或 Provider 会话生命周期。

## 术语与最终决策

| 术语 | 定义 |
|---|---|
| 权威来源 | 当前运行时直接读取的 Agent 原生 JSONL、SQLite 或兼容存储，不是 DB 中的对话副本 |
| 读取水位 | 一次运行开始时记录的文件边界或 SQLite 读事务视图；只用于本轮一致性，不持久化原文 |
| Coverage Ledger | 对每个选中 Session 的源读取、模型处理、相关性和错误状态进行逐项记账的运行对象 |
| Session Capsule | Map 阶段针对一个 Session 或其有序分片生成的、带原始 locator 的结构化摘要 |
| Claim Gate | Reduce 后的确定性边界检查；决定是否允许出现“全部读取 / 完整总结”等集合级声明 |
| Benchmark | 固定、人工构造、脱敏的评测案例；这是测试基准，不是生产数据快照 |

最终技术选择：

- 生产查询采用 Query Planner + 权威来源直读，不采用 RAG 或 Graph。
- 不保存持久化快照；只在单次运行内建立读取水位并检测 `changedDuringRun`。
- Prompt 只表达任务、证据安全边界和输出 Schema，不再承担完整读取责任。
- Langfuse 本地部署只承载 Dataset Run、Trace、Score 和版本对比，不成为运行时依赖。

## 架构

```text
用户请求 + 当前 Session Context selection
                    │
                    ▼
            Scope Resolver
      固定 selected 集合、排除当前/内部会话
                    │
                    ▼
             Query Planner
       auto → complete / targeted
                    │
                    ▼
          Live Source Readers
 JSONL 水位 / SQLite 读事务 / Copilot fallback
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
     Normalized Messages   Coverage Ledger
          │                   │
          ▼                   │
   Session/Chunk Map Jobs     │
          │                   │
          ▼                   │
     Session Capsules         │
          └─────────┬─────────┘
                    ▼
             Reduce Synthesis
                    │
                    ▼
               Claim Gate
                    │
                    ▼
       最终回答 + Coverage 摘要 + 限制

固定脱敏 Benchmark ──▶ Local Eval Runner ──▶ JSON report
                                      └────▶ Optional Langfuse Reporter
```

### 运行边界

- Scope Resolver、Reader、Normalizer、Coverage Ledger 和 Claim Gate 位于 Core，保持 Provider 无关。
- Map 使用 App 已有 Native Provider Runtime 的隔离内部 job；最终 Reduce 复用用户当前 Native Chat 的
  `chatId/nativeSessionId`，替代该轮普通 `sendTurn`，保证 Provider 原生会话仍包含用户问题和最终回答。
- Renderer 只负责显示进度、Coverage 结果、限制和取消入口，不自行计算覆盖率。
- Langfuse SDK 只出现在独立 eval workspace，不进入 Core 或 App 生产依赖。

## 触发与查询模式

### 输入范围

`selected` 必须严格等于当前 Chat Session Context 的完整 replace 集合：

- 不因关键词命中擅自扩大 Session 范围。
- 不把 UI 当前筛选结果误当作已选集合。
- 不把当前 Native Chat 自己、Rules Generation 会话或 Evidence 内部 Map/Reduce 会话重新纳入来源。
- 集合变化时以新的 `revision` 为准；运行开始后选择变化只影响下一轮，不改变本轮范围。

### Query Planner

```ts
export type SessionEvidenceMode = 'auto' | 'complete' | 'targeted'

export interface SessionEvidenceQuery {
  runId: string
  requestText: string
  selected: Array<{ agent: AgentName; id: string }>
  mode: SessionEvidenceMode
  currentNativeSessionId?: string
  signal?: AbortSignal
}

export interface SessionEvidencePlan {
  runId: string
  mode: Exclude<SessionEvidenceMode, 'auto'>
  selected: Array<{ agent: AgentName; id: string }>
  reason: string
  batchByteBudget: number
  maxConcurrency: number
}
```

`auto` 的判定原则：

1. 用户要求“全部 / 所有 / 完整 / 总结这些 Session / 归纳经验 / 跨会话比较 / 覆盖情况”等集合级结论时，使用 `complete`。
2. 用户只要求从历史中寻找某个事实、例子或单点上下文时，使用 `targeted`。
3. Planner 对是否需要集合级结论不确定时，偏向 `complete`；成本增加可以展示和取消，虚假完整声明不可接受。

`targeted` 不是“完整读取的低成本版本”：它可以提前停止模型处理，只能声称“在已处理证据中发现”，不能声称已总结完整集合。

## 读取一致性与权威来源

### JSONL 来源

适用于 Claude、Codex、Cursor、Pi，以及以 `events.jsonl` 持久化的 Copilot：

1. 运行开始时记录文件集合、每个文件的字节长度和 `mtimeMs`。
2. Reader 只读取记录长度以内的完整行；运行期间追加的新内容留到下一轮。
3. 目录型 Session 固定开始时发现的文件集合，运行中新增文件不进入本轮。
4. 读取结束再次检查长度和时间；变化时标记 `changedDuringRun=true`，但不把本轮已读证据作废。

### SQLite 来源

适用于 OpenCode 和使用 `session-store.db` 的 Copilot：

1. 按数据库路径复用只读连接。
2. 在短生命周期只读事务中批量读取本轮选中 Session，完成标准化后立即结束事务。
3. 记录事务前后的 `PRAGMA data_version` 或等价水位；变化时设置 `changedDuringRun=true`。
4. 不在 LLM Map/Reduce 期间长期占用 SQLite 读事务。

### 不可用来源

- DB 中存在索引但源文件不存在：`unavailable`。
- 源存在但格式损坏、查询报错或权限拒绝：`failed`。
- 成功读取但没有可见 user/assistant 内容：`empty`。
- 单个 Session 失败不阻断其他 Session，但必须进入 Ledger；不得只打印 warning 后 `continue`。

## 数据模型

### Coverage Ledger

```ts
export type SessionSourceStatus =
  | 'readable'
  | 'empty'
  | 'unavailable'
  | 'failed'

export type SessionProcessingStatus =
  | 'not_required'
  | 'pending'
  | 'processed'
  | 'failed'

export interface SourceRevision {
  kind: 'jsonl-watermark' | 'sqlite-transaction'
  fingerprint: string
  changedDuringRun: boolean
}

export interface SessionCoverageRow {
  sessionId: string
  agent: AgentName
  selected: true
  visited: boolean
  sourceStatus: SessionSourceStatus
  processingStatus: SessionProcessingStatus
  relevant: boolean
  messageCount: number
  sourceRevision?: SourceRevision
  errorCode?: string
  errorMessage?: string
}

export type CoverageStatus = 'complete' | 'targeted' | 'partial' | 'failed'

export interface CoverageLedger {
  runId: string
  mode: 'complete' | 'targeted'
  status: CoverageStatus
  selected: number
  visited: number
  readable: number
  empty: number
  unavailable: number
  readFailed: number
  processed: number
  processFailed: number
  relevant: number
  changedDuringRun: number
  rows: SessionCoverageRow[]
}
```

完整模式必须满足：

```text
selected = readable + empty + unavailable + readFailed
visited = selected
processed + processFailed = readable
relevant <= processed
```

只有以下条件同时成立，`status` 才能为 `complete`：

```text
mode = complete
visited = selected
unavailable = 0
readFailed = 0
processed = readable
processFailed = 0
```

`empty` 是被成功访问并确认没有可处理正文的终态，不计入失败；`changedDuringRun` 必须在回答中披露，但不自动把本轮降为
`partial`，因为读取水位已经固定了本轮证据边界。

### Locator 与 Capsule

```ts
export interface LiveEvidenceLocator {
  sessionId: string
  agent: AgentName
  messageIndex: number
  timestamp?: string
  sourceRevision: string
}

export interface EvidenceFact {
  id: string
  text: string
  kind: 'explicit' | 'inferred'
  locators: LiveEvidenceLocator[]
}

export interface SessionCapsule {
  sessionId: string
  agent: AgentName
  chunkIndex: number
  chunkCount: number
  summary: string
  facts: EvidenceFact[]
  relevant: boolean
}

export interface SessionEvidenceSynthesis {
  answerMarkdown: string
  claims: Array<{
    text: string
    evidenceFactIds: string[]
  }>
  limitations: string[]
}
```

要求：

- `messageIndex` 延续现有 `EvidenceExcerpt.locator` 的原始消息索引语义，不能用过滤后的可见数组下标替代。
- `sourceRevision` 只保存非敏感指纹，不保存源路径或正文。
- `inferred` 事实必须由多个明确 locator 支持，并在最终表述中标为归纳，不得伪装成用户原话。
- Reduce 只能引用 Capsule 中存在的 `EvidenceFact.id`；Claim Gate 必须验证所有引用可解析。

## 接口设计

### Core Engine

```ts
export interface LiveSessionEvidenceEngine {
  plan(query: SessionEvidenceQuery): Promise<SessionEvidencePlan>
  read(plan: SessionEvidencePlan): Promise<LiveSessionReadResult>
  map(
    plan: SessionEvidencePlan,
    readResult: LiveSessionReadResult,
    runner: EvidenceModelRunner,
  ): Promise<SessionMapResult>
  reduce(
    query: SessionEvidenceQuery,
    plan: SessionEvidencePlan,
    mapResult: SessionMapResult,
    runner: EvidenceModelRunner,
  ): Promise<SessionEvidenceRunResult>
}

export interface SessionEvidenceRunResult {
  runId: string
  plan: SessionEvidencePlan
  synthesis: SessionEvidenceSynthesis
  coverage: CoverageLedger
  renderedAnswer: string
}
```

### Model Runner

```ts
export interface EvidenceModelRunner {
  runMap(input: EvidenceMapInput): Promise<SessionCapsule>
  runReduce(input: EvidenceReduceInput): Promise<SessionEvidenceSynthesis>
}
```

- App 使用 `ChatRuntimeManager` 适配 `EvidenceModelRunner`。Map job 使用独立 `chatId/runId`，不追加为可见用户消息；Reduce
  job 使用真实 Chat 的 `chatId/nativeSessionId`，返回该轮最终结构化回答并维持后续 resume 连续性。
- Claude、Codex、OpenCode 使用原生结构化输出 Schema。
- Pi 若没有原生 Schema，使用严格 JSON Prompt + Zod 校验；解析失败按受控次数重试，仍失败则记入 `processFailed`。
- 所有内部 Prompt 带不可见的 host marker；扫描和 Scope Resolver 必须排除这些内部 Provider Session，防止自我回灌。
- 中断信号同时终止未完成 Reader、Map 和 Reduce job；已经完成的 Coverage 行仍可用于失败诊断。

### Native Chat 集成

```ts
export interface NativeChatSendRequest {
  // 现有字段保持不变
  sessionEvidenceMode?: 'auto' | 'complete' | 'targeted'
}
```

- 默认值为 `auto`，不要求用户每轮额外选择。
- 无 Session Context 时保持现有普通 Chat 路径。
- `targeted` 可以继续使用轻量 Host Context，但必须显示为目标检索，不显示完整覆盖。
- `complete` 先完成 Source Read 和隔离 Map，再把 Capsules、Coverage 与用户问题交给真实 Native Chat 的 Reduce Turn；
  Claim Gate 验证 Reduce 结果后才追加可见 Assistant 消息。
- Renderer 展示阶段进度：规划范围 → 读取 `n/N` → 处理 `n/N` → 汇总 → 完成/部分完成。
- 用户取消后，不输出伪装成完成结果的总结；Chat Turn 明确进入 interrupted/cancelled 状态。

### Claim Gate

```ts
export interface ClaimGateResult {
  allowed: boolean
  coverageStatus: CoverageStatus
  violations: Array<
    | 'false-complete-claim'
    | 'unknown-evidence-ref'
    | 'missing-limitations'
    | 'secret-leak'
  >
  renderedAnswer: string
}
```

Claim Gate 必须执行：

1. Coverage 不是 `complete` 时，移除或拒绝“全部读取、完整总结、没有遗漏”等声明。
2. Coverage 为 `partial` 时，在正文前显示失败/不可用数量及范围限制。
3. Coverage 为 `targeted` 时，明确使用“在本次处理的证据中”语义。
4. 所有 `evidenceFactIds` 必须存在，且 locator 必须属于本轮 `processed` Session。
5. 输出再次执行 secrets redaction；命中疑似敏感信息时阻止原文进入可见回答。

Claim Gate 不声称能在运行时确定性证明任意自然语言事实都被语义支持；“无证据事实率”由固定 Benchmark 和人工抽检验证。

## 临时上下文与持久化

### 临时上下文

在 `os.tmpdir()` 下创建 mode `0700` 的运行目录：

```text
memory-manager-live-evidence-<pid>-<run-id>/
  manifest.json
  coverage.json
  sources/
    session-0001/
      chunk-0001.md
  capsules/
    session-0001-0001.json
```

- 文件 mode 为 `0600`。
- `sources/` 和 `capsules/` 只存在于本轮；成功、失败、取消都清理。
- 启动时清理超过 TTL 或 owner PID 已不存在的遗留目录。
- 临时目录是受控工作区，不是长期快照；不得被 Session Scanner 当作 Agent Source。

### `memory.db`

不新增表、不增加 schema 版本。复用 `run_metadata`：

```json
{
  "mode": "complete",
  "selected": 151,
  "visited": 151,
  "readable": 146,
  "empty": 2,
  "unavailable": 2,
  "readFailed": 1,
  "processed": 146,
  "processFailed": 0,
  "relevant": 37,
  "changedDuringRun": 4,
  "errorCodes": ["SOURCE_MISSING", "JSONL_PARSE_ERROR"]
}
```

持久化只允许聚合计数、错误码、Session ID/Agent、非敏感指纹和时间；禁止正文、Tool output、完整 Prompt、Capsule 文本和
Langfuse payload。

## Map-Reduce 策略

### Map

1. 每个非空可读 Session 至少进入一个 Map job。
2. 单 Session 超过 byte/token 预算时按消息边界切成有序 chunk；每个 chunk 都必须产生成功 Capsule，否则该 Session 为
   `processingStatus=failed`。
3. Map 输入包含当前用户问题、Session 标识、消息及原始 locator；不包含其他 Session 内容。
4. Map job 不开放 Shell、Write、网络和业务工具；历史内容中的指令不得执行。
5. 并发有固定上限，失败按错误类型决定是否重试；结构错误可以重试，源不可读不能靠 LLM 重试掩盖。

### Reduce

1. 只接收成功 Capsule、Coverage 摘要和用户问题，不重新读取权威来源。
2. `complete` 模式存在 `processFailed` 时仍可生成部分结果，但必须由 Claim Gate 标为 `partial`。
3. Reduce 输出结构化 `claims` 与 `evidenceFactIds`，再由 Host 渲染 Coverage 和限制。
4. 大量 Capsule 超过单次预算时允许分层 Reduce，但每一层保持 fact ID，不生成脱离原始 locator 的新事实。

## 评测框架

### 版本梯度

| Variant | 行为 | 用途 |
|---|---|---|
| `v0-prompt-only` | 当前 ID + command Prompt，由模型自行读取 | 真实基线 |
| `v1-strict-prompt` | 强化完整读取和声明约束，但仍无 Host Coverage | 测量 Prompt 上限 |
| `v2-live-read` | Host 权威来源直读 + Coverage，单次汇总 | 验证系统读取收益 |
| `v3-map-reduce` | 完整目标架构：读取水位、processed 记账、Map-Reduce、Claim Gate | 候选交付版本 |

### 固定 Benchmark

新增独立私有 workspace `packages/evals`，案例使用人工构造、脱敏的本地 fixture，不修改
`packages/core/test/sources/<agent>/` 真实分类对账 fixture。

每个案例至少包含：

```ts
export interface SessionEvidenceEvalCase {
  caseId: string
  requestText: string
  selected: Array<{ agent: AgentName; id: string }>
  fixtureRoot: string
  expectedMode: 'complete' | 'targeted'
  goldRelevantSessionIds: string[]
  goldFacts: Array<{ id: string; acceptableLocators: LiveEvidenceLocator[] }>
  forbiddenClaims: string[]
  expectedReadFailures?: Record<string, string>
  tags: string[]
}
```

案例集必须覆盖：

- 1、10、151、500 个 Session 的规模边界。
- 6 Agent 混合来源。
- 空、missing、损坏 JSONL、SQLite 查询失败和 metadata-only Copilot。
- 运行中追加 JSONL、SQLite `data_version` 变化。
- 历史 Session 内的 Prompt injection、shell 指令和伪造 system prompt。
- 同一事实多 Session 重复、矛盾事实和跨 chunk locator。
- 真实 Secret 形态的合成 token、邮箱和路径脱敏。
- Provider 返回非法结构、Map 单项失败、Reduce 失败和用户取消。

### 指标与门禁

先执行硬门禁：

| Score | 通过条件 |
|---|---|
| `source_accounting_pass` | 每个 selected Session 都进入且只进入一个源终态 |
| `processing_accounting_pass` | complete 模式每个 readable Session 都 processed 或明确 processFailed |
| `false_complete_claim_pass` | partial/targeted 结果中虚假完整声明为 0 |
| `locator_validity` | 100% locator 可回到固定 fixture 的原始消息 |
| `secret_leak_pass` | 可见输出和 Reporter payload 泄漏为 0 |

硬门禁全部通过后才比较：

- `relevant_session_recall`
- `relevant_session_precision`
- `gold_fact_recall`
- `evidence_support_precision`
- `human_pairwise_preference`
- P50/P95 latency
- LLM 调用数、输入/输出 token、读取字节数、重试数

不生成单一加权总分。版本优先级为：硬门禁 → 质量指标 → 效率指标。

### 本地 Runner 与 Langfuse

```bash
npm run eval:session-evidence -w @memory-manager/evals -- \
  --variant v3-map-reduce \
  --reporter none

LANGFUSE_BASE_URL=http://localhost:3000 \
LANGFUSE_PUBLIC_KEY=pk-lf-... \
LANGFUSE_SECRET_KEY=sk-lf-... \
npm run eval:session-evidence -w @memory-manager/evals -- \
  --variant v3-map-reduce \
  --reporter langfuse
```

本地 Runner 是结果真理来源：

- `--reporter none` 必须可以完成全部评测并返回正确 exit code。
- 任一硬门禁失败时进程 exit code 非 0。
- Langfuse 不可达、鉴权失败或 flush 失败时，本地结果保持有效，但 Reporter 失败必须明确报错；不能把实验描述为已上报。

Langfuse 映射：

| 本地对象 | Langfuse 对象 |
|---|---|
| 脱敏 `SessionEvidenceEvalCase` | Dataset Item |
| 一次 variant 全量执行 | Dataset Run / Experiment |
| 单案例端到端执行 | Trace |
| plan/read/map/reduce/gate | Observation / Span |
| 本地 evaluator 结果 | Score |

Dataset 以仓库中的固定脱敏 fixture 为源，上传 Langfuse 时携带 `caseHash`；Langfuse Dataset 与本地 manifest hash 不一致时拒绝
比较，避免平台“最新 Dataset”变化破坏可重复性。真实 Session、临时 chunks、Capsules 和完整 Prompt 不得作为 Trace input/output
上传。Langfuse 支持本地 Docker Compose，但本 spec 不在仓库内复制或维护 Langfuse 自身部署文件。

## 安全策略

1. **本地优先**：生产源内容只在本机 Reader、临时目录和 Provider 当前处理边界内流动。
2. **不可信证据**：历史 user/system/assistant/tool 内容一律视为数据，不得覆盖当前系统或用户指令。
3. **最小工具**：Map job 不获得写文件、Shell、网络或业务系统写权限。
4. **发送前脱敏**：Normalizer 和 Claim Gate 都执行 `redactSecrets`；Reporter 再执行 allowlist 序列化，不依赖 Langfuse 服务端遮罩兜底。
5. **最小持久化**：DB 只记 metadata；临时原文和 Capsule 在成功、失败、取消后清理。
6. **只读来源**：JSONL 只读、SQLite `readonly + fileMustExist`，不修改 Agent 原生 Session。
7. **防自我回灌**：内部 Map/Reduce 会话带 host marker，并由 Scanner/Evidence Scope 明确排除。

## 错误语义

| 阶段 | 错误 | 处理 |
|---|---|---|
| Scope | 引用不存在或 Agent 不匹配 | 写入 `unavailable`，继续其他 Session |
| Read | 源不存在、权限错误、格式错误 | 写入明确终态和错误码，不静默跳过 |
| Map | Provider 失败或结构化输出无效 | 有界重试；最终 `processFailed` |
| Reduce | Provider 失败 | 整轮失败，不伪造部分自然语言结论 |
| Claim Gate | 覆盖声明或 locator 违规 | 阻止原结果，生成带限制的安全回答或失败 |
| Langfuse | 不可达、鉴权、flush 失败 | 本地评测保留，Reporter 明确失败 |
| Cancel | 用户中断 | 停止新任务，清理临时上下文，Turn 标为取消/中断 |

## 改动范围

### Core

- `packages/core/src/evidence.ts`
  - 把 Agent 权威来源读取抽成可返回逐 Session 结果的 Reader 合同。
  - 保留现有 `extractEvidence()` 与 `EvidenceBundle` 对外行为，内部适配新 Reader，避免破坏 Rules Generation caller。
  - 失败从“stderr warning + continue”改为可供新引擎记账；旧 caller 的兼容呈现需在适配层明确。
- `packages/core/src/session-context.ts`
  - 复用严格的 reference 解析和 DB 行解析，提供 Scope Resolver 所需的完整选中集合解析。
- `packages/core/src/commands/sessions.ts`
  - 复用或下沉 6 Agent 的原生读取逻辑，避免 CLI `sessions show` 和引擎形成两套格式解释。
- `packages/core/src/evidence-context.ts`
  - 扩展为 Live Evidence 临时 manifest/chunk writer，加入读取水位与 Capsule 生命周期；保留现有 Rules Evidence Context 合同。
- 新增 `packages/core/src/live-session-evidence.ts`
  - Query Plan、Coverage Ledger、Map/Reduce 输入输出和 Claim Gate 的 Provider-neutral 编排。
- 新增 `packages/core/src/evidence-coverage.ts`
  - 覆盖计数、状态转换、公式校验和安全渲染纯函数。
- `packages/core/src/db.ts`
  - 不改 schema；只确认 `run_metadata.run_type/details` 可记录新运行摘要。

### App

- `packages/app/main/native-chat-controller.ts`
  - 在需要 Session Evidence 的 Turn 中调用新引擎；普通无 Context Chat 保持现状。
  - 将 Coverage 进度和最终限制送给 Renderer，并让 interrupt 覆盖内部 Map/Reduce job。
- `packages/app/main/chat-runtime.ts`
  - 增加内部 Map job 的隔离 Runner/生命周期，并让 Reduce 复用真实 Chat 的 Provider Adapter 和 native handle；不把 Map
    中间结果追加为可见 Chat 消息。
- `packages/app/main/session-context-prompt.ts`
  - 从“要求 Provider 自行读取 ID 列表”调整为 Host 已准备证据、Coverage 和输出边界的 Prompt。
  - `v0/v1` eval variant 保留旧 Prompt 构造器作为基线，不继续作为 `v3` 的生产责任边界。
- `packages/app/main/session-context-input.ts`
  - 复用临时 mention 和 cleanup 机制传递受控 manifest/chunk，不持久化隐藏内容。
- `packages/app/main/{claude,codex,opencode,pi}-chat-adapter.ts`
  - 对齐 EvidenceModelRunner 的结构化输出与失败语义；Pi 增加 JSON 校验路径。
- `packages/app/renderer/src/views/ChatView.tsx`、相关 `types.ts` 与 i18n
  - 显示读取/处理进度、Coverage 摘要、partial/targeted 限制和取消状态。

### Evaluation

- 新增 `packages/evals/package.json` 与 `packages/evals/src/session-evidence/*`
  - Variant runner、固定案例 loader、本地 evaluators、JSON report、Reporter 接口。
- 新增 `packages/evals/fixtures/session-evidence/*`
  - 只放人工构造和脱敏 fixture；不复制本机真实 Session。
- 根 `package.json`
  - 增加统一 eval script，不改变现有 `build` / `test` 默认行为。
- Langfuse SDK 依赖只加入 `@memory-manager/evals`，不进入 Core/App 生产包。

### Tests

- `packages/core/test/unit/evidence.test.ts`
  - 保持现有 Evidence 资格与路由回归，增加逐 Session source result。
- 新增 `packages/core/test/unit/evidence-coverage.test.ts`
  - 状态机、公式、完整/部分/targeted 判定和 Claim Gate。
- `packages/core/test/unit/evidence-context.test.ts`
  - 水位 manifest、权限、清理、跨 chunk locator。
- `packages/app/test/native-chat-controller.test.ts`
  - Host 主导执行、进度、取消、Provider 失败、不可见中间 Turn。
- `packages/app/test/session-context-prompt.test.ts`
  - v3 Prompt 不再把读取责任交给模型；v0/v1 基线仍可重复运行。
- 6 个 Provider Adapter 定向测试
  - 结构化 Map/Reduce 输出和错误归一化。

## 假设

- ⚠ `auto` Planner 首版可以通过结构化模型判断 + 保守 fallback 稳定区分集合级总结和单点检索；实现时必须用固定中英文
  query 集做反向测试，若误判不可接受，则在 Session Context UI 增加显式 `完整审阅 / 目标检索` 控件并改写本节。
- ⚠ Pi 当前没有与 Claude/Codex/OpenCode 等价的原生 `outputSchema` 结果；实现时必须先证明严格 JSON + Zod + 有界重试
  能达到同一错误合同，否则需要先扩展 Pi Adapter 能力，不能静默降低 Coverage 语义。

## 风险

- **读取了不等于处理了**：仅有 `readable` 会再次制造虚假安全感。Ledger 独立记录 `processed/processFailed`，完整声明同时受两层约束。
- **Map 压缩遗漏重要事实**：所有 Capsule 保留原始 locator，以 Gold Fact Recall 和 Evidence Support Precision 做回归；不能只看主观“总结不错”。
- **151～500 Session 成本和延迟过高**：按消息边界分片、有界并发、可取消；性能优化只能在硬门禁通过后进行。
- **来源在运行中变化**：读取水位固定本轮边界并披露 `changedDuringRun`，不尝试构造跨 6 Agent 的全局原子快照。
- **内部总结 Session 被再次扫描**：内部 Prompt marker + native handle metadata 双重排除；Benchmark 必须覆盖自我回灌。
- **历史内容 Prompt injection**：Map Runner 不给执行工具，Prompt 明确证据数据边界；恶意 fixture 必须证明不会触发命令或写操作。
- **Langfuse 泄漏或平台锁定**：Reporter 使用字段 allowlist，默认 `none`；本地 JSON report 和 exit code 是真理来源。
- **Langfuse API/数据模型版本漂移**：eval workspace 锁定 SDK 版本，通过 Reporter contract test 隔离；生产包不直接依赖。

## 验收链路

### 定向自动化

```bash
npm test -w @memory-manager/core -- --runInBand \
  packages/core/test/unit/evidence.test.ts \
  packages/core/test/unit/evidence-coverage.test.ts \
  packages/core/test/unit/evidence-context.test.ts

npm test -w @memory-manager/app -- --runInBand \
  packages/app/test/native-chat-controller.test.ts \
  packages/app/test/session-context-prompt.test.ts \
  packages/app/test/claude-chat-adapter.test.ts \
  packages/app/test/codex-chat-adapter.test.ts \
  packages/app/test/opencode-chat-adapter.test.ts \
  packages/app/test/pi-chat-adapter.test.ts
```

### 固定 Benchmark

```bash
npm run eval:session-evidence -w @memory-manager/evals -- \
  --variant v0-prompt-only --reporter none

npm run eval:session-evidence -w @memory-manager/evals -- \
  --variant v1-strict-prompt --reporter none

npm run eval:session-evidence -w @memory-manager/evals -- \
  --variant v2-live-read --reporter none

npm run eval:session-evidence -w @memory-manager/evals -- \
  --variant v3-map-reduce --reporter none
```

`v3-map-reduce` 必须证明：

1. 151 和 500 Session 案例满足 source/processing accounting，单个失败不会从 Ledger 消失。
2. `partial` 和 `targeted` 输出的虚假完整声明为 0。
3. 所有事实 locator 100% 可解析到固定 fixture 的原始消息索引。
4. `changedDuringRun` 只影响限制说明，不把水位之后追加的数据混入本轮。
5. Prompt injection fixture 不触发 Shell、Write、网络或业务写工具。
6. 可见回答、DB metadata、本地 report 和 Langfuse allowlist payload 不包含合成 Secret 原文。
7. 任一硬门禁失败时 eval 进程非 0；质量或效率指标退化在报告中明确显示。
8. Langfuse 不可用时 `--reporter none` 完整工作，`--reporter langfuse` 明确报告上报失败。

### 全量回归与构建

```bash
npm test -w @memory-manager/core
npm test -w @memory-manager/app
npm run build -w @memory-manager/core
npm run build -w @memory-manager/app
git diff --check
```

必须证明现有行为不回归：

1. 无 Session Context 的普通 Chat 不增加隐藏 Map/Reduce 调用。
2. Session Context replace revision、Provider 失败重试和 Codex 临时 mention cleanup 保持正确。
3. Rules Generation 继续使用现有 Evidence 资格、Baseline、candidate schema 和 sourceSession 语义。
4. 6 Agent 的 `sessions show --stream` 行为与新 Reader 对同一 fixture 解析结果一致。
5. `memory.db` schema 版本和三表模型不变，DB 中没有对话正文、Tool output 或完整 Prompt。
6. 用户取消后无运行中的内部 Provider job、无遗留临时 Evidence 目录。

### 本机 Smoke 与视觉验收

使用隔离 HOME 和人工 fixture 启动 production Electron：

1. 选择跨 Agent Session，发送集合级总结请求，观察规划、读取、处理、汇总阶段和最终 Coverage。
2. 人为删除一个源后重跑，确认 UI 为 partial、显示失败数量且不声称完整读取。
3. 运行过程中追加 JSONL，确认显示 `changedDuringRun`，本轮结果不包含追加内容。
4. 中途取消，确认 UI、ChatStore、Provider job 和临时目录全部进入一致终态。
5. 验收不得选择或修改用户真实 Session，不得把 fixture Chat 留在主应用数据中。

## 后续实现顺序

建议按最小可验证链路实现：

1. 抽取统一 Source Reader，先让 6 Agent 逐 Session 返回 `readable/empty/unavailable/failed`，保持现有 CLI 与 Rules 回归。
2. 实现 Coverage Ledger 纯状态机和 Claim Gate，以无 LLM 的 fixture 测试锁定 source/processing accounting。
3. 实现 JSONL 水位、SQLite 读事务和临时 Evidence Context，验证变化检测、权限和清理。
4. 定义 Session Capsule、Map/Reduce Schema 与 Provider-neutral `EvidenceModelRunner`，先打通单 Session 端到端骨架。
5. 扩展到多 Session/多 chunk、有界并发、取消和所有 Native Provider，补齐内部 Session 排除。
6. 接入 Native Chat auto/complete/targeted 编排及 Renderer 进度、Coverage 和限制展示。
7. 建立 `@memory-manager/evals`，先跑 v0/v1/v2/v3 固定脱敏 Benchmark 和 CI 硬门禁。
8. 增加可选本地 Langfuse Reporter，验证字段 allowlist、Dataset hash、Score 和失败隔离。
9. 完成本机 Electron smoke、全量测试、构建、`memory/process.md` 同步、commit 和 push。

本 spec 的实现步骤超过 5 行且同时涉及 Core/App 两个子项目；用户明示 review 对齐后，应按 `flow-spec` 规则单独生成
`docs/plans/live-session-evidence-evaluation.md`，细化每步观察点、验证方式和 reviewed 状态。

## 回归点

- Native Chat：新建/恢复 Turn、Context revision、Provider lock、取消、失败重试、Timeline 和 ChatStore 可见消息。
- Session Context：全选/取消、replace 语义、最多 500 references、missing 状态和可读名称。
- Rules Generation：Evidence 提取、选择性读取、Baseline、candidate qualifier、内部 Session 排除。
- Source 读取：Claude、Codex、Copilot、Cursor、OpenCode、Pi 的 CLI 与 Core Reader 一致性。
- Provider：Claude/Codex/OpenCode 原生 Schema，Pi JSON fallback，内部 job 生命周期。
- 隐私：DB、ChatStore、临时目录、日志、eval report、Langfuse payload。

## 参考

- 现有 Session Context Prompt：`packages/app/main/session-context-prompt.ts`
- 现有 Native Chat 编排：`packages/app/main/native-chat-controller.ts`
- 现有 Session Context 临时附件：`packages/app/main/session-context-input.ts`
- 现有 Evidence 回源和 locator：`packages/core/src/evidence.ts`
- 现有 Evidence 临时 manifest/batches：`packages/core/src/evidence-context.ts`
- 现有 Session 查询：`packages/core/src/session-context.ts`
- 现有 6 Agent `sessions show`：`packages/core/src/commands/sessions.ts`
- 总规格与内容存储红线：`docs/specs/memory-manager-spec.md`
- Langfuse 本地部署：https://langfuse.com/self-hosting/deployment/docker-compose
- Langfuse SDK Experiments：https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk
- Langfuse Scores API/SDK：https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk
- Langfuse 客户端 Masking：https://langfuse.com/docs/observability/features/masking
