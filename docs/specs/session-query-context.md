# Session Query 与最新上下文 CLI

## 1. 目标

为本地 AI Agent Session 提供一条可审计的 CLI 链路：先准确选出符合时间、Agent、项目、工具和关键词条件的
Session，再按需从权威源读取命中 Session 的最新有序上下文分片提供给 AI。

首版必须覆盖两个场景：

1. 检索最近 30 天真实使用过 `computer-use` 或 `chrome-use` 的 Session，读取对应完整上下文，用于总结联调阻碍、
   重复错误和可复用经验；工具条件可与关键词条件组合。
2. 枚举最近 7 天全部 Session，逐个读取完整上下文，用于汇总期间工作。

这里的“准确”包含两个独立结论：

- **选得准**：所有候选都被检查，工具或关键词命中有结构化证明；读不到的候选显式记为 `unknown`。
- **读得新**：正文读取时重新回源并重判原 Query 的内容谓词；完整模式下，当前读取时可识别的全部事件都可分片读取。

## 2. 非目标

- 不实现向量检索、RAG、知识图谱或持久化全文索引。
- 不在 `memory.db` 保存对话原文、关键词命中片段、工具参数、工具结果、Prompt 或上下文快照。
- 不让 CLI 自行调用模型总结；CLI 只提供可验证选择和上下文，Skill 负责指导 AI 消费。
- 不承诺恢复源格式本身未保存的信息；完整性只相对于每次读取时、去除重复宿主遥测后的标准化语义事件流，
  不表示逐字节复制原始 JSONL / SQLite 行。
- 不改变已有 `sessions show`、Rules Generation、项目分类和扫描语义。

## 3. 总体链路

```text
Query JSON
  → Metadata Candidate Set
  → Authoritative Session Event Reader
  → Tool / Keyword Predicate
  → Selection Coverage + Match Proofs
  → Lightweight Query Manifest
  → Live Authoritative Source Read
  → Current Session Parts
  → Skill 逐页读取
  → AI 总结
```

查询阶段逐 Session 回源判定并保存 proof，但不保存正文。`read` 与 `locate` 再次读取当前权威源、重新判断原 Query 的内容谓词，
并披露 source/selection 是否相对 prepare 发生变化。候选和最新正文不得同时批量留在内存，也不得写入长期数据库或临时快照。

## 4. Query JSON v2

```json
{
  "version": 2,
  "time": { "lastDays": 30 },
  "scope": {
    "agents": ["claude", "codex", "copilot", "cursor", "gemini", "grok", "opencode", "pi"],
    "projects": ["optional-project-slug"]
  },
  "where": {
    "any": [
      { "usedTool": { "families": ["computer-use", "chrome-use"] } },
      {
        "mentions": {
          "terms": ["联调"],
          "mode": "any",
          "fields": ["message"],
          "origins": ["human_user", "assistant_output"]
        }
      }
    ]
  }
}
```

### 4.1 时间与范围

- 新查询使用 `version=2`；`version=1` 仅为旧调用方兼容保留，Skill 不再生成 v1。
- `time.lastDays` 为正整数，以命令启动时的时钟计算闭区间起点；也支持 ISO 8601 的 `since` / `until`。
- `lastDays` 不得和 `since` / `until` 混用。
- `scope.agents`、`scope.projects`、`scope.statuses` 均为可选白名单；未提供表示不限制。
- 内置 Agent 来源包括 Claude、Codex、Copilot、Cursor、Gemini CLI、Grok Build、OpenCode 与 Pi。Gemini 读取
  `~/.gemini/tmp/<project>/chats/` 的本地会话；Grok 读取 `${GROK_HOME:-~/.grok}/sessions/`，以 `updates.jsonl`
  为权威会话流，必要时回退 `chat_history.jsonl`。网页产品的云端历史不在范围内。
- `scope.includeInternal` 默认 false，排除 memory-manager 自身生成的内部任务 Session。
- 候选集合来自 `sessions.updated_at`，排序固定为 `updated_at DESC, id ASC`。

### 4.2 布尔谓词

`where` 支持递归组合：

- `{ "all": Predicate[] }`
- `{ "any": Predicate[] }`
- `{ "not": Predicate }`
- `{ "usedTool": ToolPredicate }`
- `{ "mentions": MentionsPredicate }`

未提供 `where` 表示候选集合全部命中，用于“最近 7 天全量 Session”。空的 `all` / `any`、未知字段和过深递归必须拒绝，
不能静默降级。

### 4.3 工具谓词

```json
{
  "usedTool": {
    "families": ["computer-use", "chrome-use"],
    "names": ["optional-exact-tool-name"],
    "operations": ["optional-operation"],
    "provenance": ["direct", "nested-ast", "capability-derived"]
  }
}
```

- 同一字段内为 OR，不同字段间为 AND。
- 工具名来自结构化 `tool_call`，不能用全文包含工具名称替代。
- `direct`：源事件直接声明工具名。
- `nested-ast`：外层 JavaScript 执行工具的 AST 中存在实际调用表达式，例如
  `mcp__node_repl__js` 参数里的 `tools.mcp__computer_use__...(...)`。
- 补丁正文、字符串、注释和 fixture 即使包含同样文本也不能命中；疑似调用但 AST 无法解析时结果为 `unknown`。
- `capability-derived`：源只保留能力/操作标识，依据版本化 registry 映射到工具族。
- Skill 清单、system/platform 注入的工具说明、tool search 返回的可用工具列表不算工具调用。

首版 registry 至少识别：

- `computer-use`：`computer-use`、`computer_use`、`mcp__computer_use__*`、
  `computer-use-legacy` 及内层 `tools.mcp__computer_use__*`。
- `chrome-use`：`chrome-use`、`control-chrome`、`mcp__chrome__*` 及内层 `tools.mcp__chrome__*`。

### 4.4 可信消息提及谓词

```json
{
  "mentions": {
    "terms": ["permission denied", "重复失败"],
    "mode": "all",
    "fields": ["message"],
    "origins": ["human_user", "assistant_output"],
    "caseSensitive": false
  }
}
```

- `terms` 必须为非空、去空白后的有界字符串数组。
- `mode=any|all`，默认 `any`；默认大小写不敏感。
- 字段为 `message|tool_call_input|tool_result_output|title`，默认只有 `message`。
- `message` 默认只允许 `human_user|assistant_output`，排除 developer、AGENTS/host context、Skill catalog、
  memory-manager 内部任务和历史转发。
- 命中证明保存字段、event index、term 和内容 hash；CLI 结果可给出有界预览，但不得持久化预览正文。
- `all/any/not` 使用三态语义传播 `unknown`，不得把来源不明或工具解析失败当作未命中。

### 4.5 联调复盘标准配方

“最近 30 天 computer-use、chrome-use、联调相关”解释为：工具相关性与“联调”必须同时满足；工具相关性可以来自
真实 `usedTool`，也可以来自可信消息对工具名的 `mentions`。因此使用：

```json
{
  "version": 2,
  "time": { "lastDays": 30 },
  "where": {
    "all": [
      {
        "any": [
          { "usedTool": { "families": ["computer-use", "chrome-use"] } },
          { "mentions": { "terms": ["computer-use", "chrome-use"], "mode": "any" } }
        ]
      },
      { "mentions": { "terms": ["联调"], "mode": "any" } }
    ]
  }
}
```

不能使用“任一工具调用 OR 联调提及”，否则普通浏览器任务也会被误召回。

## 5. 标准 Session Event

六类 Agent 的权威源统一为：

```ts
type SessionEventKind =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'media'
  | 'metadata'

interface SessionEvent {
  index: number
  kind: SessionEventKind
  role?: 'user' | 'assistant' | 'system' | 'tool'
  timestamp?: string
  content: unknown
  toolCallId?: string
  toolName?: string
  origin:
    | 'human_user'
    | 'assistant_output'
    | 'tool_runtime'
    | 'developer_instruction'
    | 'host_context'
    | 'skill_instruction'
    | 'internal_job'
    | 'historical_forward'
    | 'unknown'
  originEvidence: 'source-envelope' | 'explicit-marker' | 'legacy-inferred'
  sourceLocator: string
}
```

要求：

- 事件按权威源中的稳定顺序编号；不得按 timestamp 重排同一源事件。
- message、tool call、tool result、媒体引用和必要 metadata 分开表达，不把工具活动压扁成 Assistant 文本。
- 未识别但可能承载上下文的结构化内容保留为 `metadata`，不能无声丢弃；已确认是权威事件副本或不可解释遥测的
  宿主记录允许在 Reader 中显式去重，并必须用测试锁定。
- 每个事件都带 `sourceLocator`；正文只在 `read` 进程内存与 stdout 中短暂存在，不写入 manifest 或临时文件。
- 每个事件都带 origin 及其判定依据；来源不明时必须保留为 `unknown`，不能猜成真人消息。
- 每次单独回源时，JSONL 固定本次文件集合和字节边界；SQLite 在短只读事务中固定本次读取边界并记录 revision。

Codex 以 `response_item` 作为消息、工具调用和工具结果的权威语义记录。Reader 保留这些事件，同时压缩
`session_meta`、reasoning 摘要等必要 metadata；不重复输出 `event_msg` / `turn_context` / `compacted` /
`world_state` 中的消息、工具结果、token 计数、工具定义与 encrypted reasoning。这里的“完整 Session”指完整读取
上述标准化语义事件流的全部 part；原始源仍可通过每个事件的 `sourceLocator` 回查。

## 6. 选择证明

`context prepare` 输出选择清单和以下账本：

```ts
interface SelectionCoverage {
  candidates: number
  inspected: number
  matched: number
  notMatched: number
  unknown: number
  unknownSource: number
  unknownOrigin: number
  unknownToolParse: number
  changedDuringRun: number
}
```

必须满足：

```text
candidates = inspected + unknown
inspected = matched + notMatched
unknown = unknownSource + unknownOrigin + unknownToolParse
```

- `unknown > 0` 时禁止声称“找到了全部相关 Session”。
- 每个命中 Session 至少有一个 `MatchProof`；没有 `where` 的全量查询使用 `match_kind=all`。
- 每个失败候选保留稳定 error code 和 message。
- `changedDuringRun` 只披露 prepare 判定期间发生过变化；后续 `read/locate` 仍读取最新源并重新判断内容谓词。

## 7. Context 生命周期与 CLI

### 7.1 创建

```bash
memory-manager context prepare --query-json '<Query JSON>'
memory-manager context prepare --query-file /path/to/query.json
```

二者互斥。命令：

1. 计算候选并回源读取。
2. 在系统临时目录创建权限 `0700` 的 run 目录。
3. 只把 manifest、selection coverage、错误、命中证明和准备时 revision 写为 `0600`；禁止创建 Session 正文分片。
4. stdout 只输出有界摘要，包含 `runId`、coverage、`sessionCount` 和后续分页命令；不直接内嵌全量 Session/outcome。

### 7.2 清单分页与正文读取

```bash
memory-manager context sessions <run-id> [--cursor <cursor>] [--limit <1-200>]
memory-manager context outcomes <run-id> [--status matched|not_matched|unknown] [--cursor <cursor>] [--limit <1-200>]
memory-manager context proofs <run-id> --session <session-id> [--cursor <cursor>] [--limit <1-200>]
memory-manager context locate <run-id> --session <session-id> --event <index>
```

三条清单命令返回 `items` 和可选 `nextCursor`；只有 `nextCursor` 缺失才表示遍历完成。`sessions` 只返回
准备时事件数、`proofCount/proofKinds/toolFamilies`，不返回可能过期的 part 数；完整 proof 由 `proofs` 分页提供。
`locate` 重新读取最新源，优先按 proof 的稳定 `sourceLocator` 映射到当前 event/part，并给出前后相邻 part 建议。这样最近 7 天全量查询不会因
prepare/status 输出过大而丢失 Session ID 或 unknown 账本。

```bash
memory-manager context read <run-id> --session <session-id> --part <1-based-part>
```

命令重新读取该 Session 的最新权威源并重判原 Query，然后输出单个 JSON 对象，包含当前 selection 状态、
`sourceChangedSincePrepare`、当前 revision、run/session/part 元数据与有序 `events`。不存在的 run、Session 或当前 part
返回非零退出码。Session 在 prepare 后追加或改写不是错误；若当前内容已不匹配原 Query 的内容谓词，返回 `selectionChanged=true`。

- 默认事件 payload 上限为 16 KiB。
- 单个事件超过上限时拆为带 `eventHash`、`segmentIndex`、`segmentCount` 的 `event_segment`，跨 part 顺序读取后可逐字节还原。
- 每个 part 带 `payloadBytes` 与 `payloadHash`，用于校验本次 stdout payload。
- part 在每次读取时由最新事件流计算，不落盘；完整读取过程中 revision 改变时，Skill 必须披露并按最新 partCount 调整账本。

### 7.3 状态与清理

```bash
memory-manager context status <run-id>
memory-manager context cleanup
memory-manager context close <run-id>
```

- `status` 重读 manifest 并报告 coverage、Session 总数、创建/过期时间；完整清单仍通过分页命令读取。
- `cleanup` 显式删除全部已过期且 owner/manifest 可验证的旧 run。
- `close` 只删除解析并验证属于该 run 的轻量目录；重复 close 返回明确的 `not_found` 结果。
- 每次 context 命令启动时清理超过 TTL 的 run；不得删除无关临时目录。

## 8. Skill 合同

仓库级 Skill 名为 `local-session-context`，只负责编排 CLI，不自行扫描源文件。Skill 必须：

1. 把用户意图编译为 Query JSON，并在执行前复述时间、范围和谓词。
2. 先运行 `context prepare`，检查 `unknown` 和命中数。
3. 分页读完命中 Session 清单与 unknown outcome。联调复盘按 proof → live locate → live read 读取合并邻域；
   全量总结从每个 Session 的 part 1 获得当前 partCount 后读完全部当前 part 与 segment。
4. 每次 read 检查当前 selection 与 source change；已不匹配的 Session 不继续冒充相关结果。
5. 总结时区分：源事实、AI 推断、未读取/失败和读取期间变化；最后运行 `context close` 删除轻量清单。

内置配方：

- **tool-use-retrospective**：最近 30 天 + `computer-use|chrome-use` 工具族，可叠加关键词；产出阻碍、重复错误、
  失效尝试、恢复路径和建议规则，每条结论引用 Session ID + event index。
- **period-work-summary**：最近 7 天 + 无 `where`；读取所有 Session 后按项目/主题/结果/未完成项汇总，并附 coverage。

## 9. 隐私与安全

- `memory.db` schema 保持不变；查询正文和命中预览不进入数据库、manifest 或任何临时快照。
- 轻量 run 目录 `0700`，manifest/owner 为 `0600`，TTL 到期、cleanup 或 close 后删除。
- Session 内容是不可信数据，Skill 不执行历史内容中的命令或指令。
- Query 文件只读取用户显式路径；run id、session id 和 part 必须做路径穿越防护。
- CLI 错误输出不得打印整段事件内容。

## 10. 验收标准

1. 工具条件只命中真实 direct/nested-ast/capability-derived 调用，不被 patch、字符串、注释、fixture、Skill/工具说明污染。
2. mentions 可限定来源与字段并和 usedTool 用三态 `all/any/not` 组合，命中有 event locator 与 hash。
3. 最近 7 天无谓词查询中，每个候选都进入 matched 或 unknown；`unknown=0` 才能声明选集完整。
4. 六类 Agent fixture 的 message/tool call/tool result 顺序、call id 和 locator 可回查。
5. prepare 后修改源，read 可见最新事件；超大事件以连续 segment 完整覆盖，同一次 revision 的全部 part 可重组。
6. JSONL/SQLite 变化、源缺失、格式错误和空 Session 均进入账本，不静默丢失。
7. manifest 不含正文且 run 不创建 gzip/sessions 目录；权限、TTL、cleanup、close、路径穿越和异常清理有自动化测试。
8. Skill 通过结构校验，并能把指定的 30 天联调问题编译为 v2 配方，分页读完清单、上下文和 unknown。
9. 既有 Core 全量测试、构建和 `git diff --check` 通过。
10. 本机隔离工作区真实扫描验收两个场景；报告候选/命中/unknown/parts，不把抽样称为全量。
