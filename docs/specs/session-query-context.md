# Session Query 与完整上下文 CLI

## 1. 目标

为本地 AI Agent Session 提供一条可审计的 CLI 链路：先准确选出符合时间、Agent、项目、工具和关键词条件的
Session，再把命中 Session 的完整有序上下文分片提供给 AI。

首版必须覆盖两个场景：

1. 检索最近 30 天真实使用过 `computer-use` 或 `chrome-use` 的 Session，读取对应完整上下文，用于总结联调阻碍、
   重复错误和可复用经验；工具条件可与关键词条件组合。
2. 枚举最近 7 天全部 Session，逐个读取完整上下文，用于汇总期间工作。

这里的“准确”包含两个独立结论：

- **选得准**：所有候选都被检查，工具或关键词命中有结构化证明；读不到的候选显式记为 `unknown`。
- **读得全**：命中 Session 在固定读取水位内的全部可识别事件都进入分片，所有分片都可被 AI 逐个读取。

## 2. 非目标

- 不实现向量检索、RAG、知识图谱或持久化全文索引。
- 不在 `memory.db` 保存对话原文、关键词命中片段、工具参数、工具结果、Prompt 或上下文快照。
- 不让 CLI 自行调用模型总结；CLI 只提供可验证选择和上下文，Skill 负责指导 AI 消费。
- 不承诺恢复源格式本身未保存的信息；完整性只相对于固定水位内的权威本地源。
- 不改变已有 `sessions show`、Rules Generation、项目分类和扫描语义。

## 3. 总体链路

```text
Query JSON
  → Metadata Candidate Set
  → Authoritative Session Event Reader
  → Tool / Keyword Predicate
  → Selection Coverage + Match Proofs
  → Frozen Private Context
  → Session Parts
  → Skill 逐页读取
  → AI 总结
```

查询和正文读取复用同一次权威源快照。不能先用模糊索引选中、再从另一个变化后的版本读取正文。
候选必须逐 Session 回源和判定；命中后立即写入 Context 分片并释放事件正文，不能把时间范围内全部候选正文同时留在内存。

## 4. Query JSON v1

```json
{
  "version": 1,
  "time": { "lastDays": 30 },
  "scope": {
    "agents": ["claude", "codex", "copilot", "cursor", "opencode", "pi"],
    "projects": ["optional-project-slug"]
  },
  "where": {
    "any": [
      { "tool": { "families": ["computer-use", "chrome-use"] } },
      {
        "keyword": {
          "terms": ["浏览器联调", "extension"],
          "mode": "any",
          "fields": ["user", "assistant", "tool_call_input", "tool_result_output"]
        }
      }
    ]
  }
}
```

### 4.1 时间与范围

- `version` 固定为 `1`，未知版本立即失败。
- `time.lastDays` 为正整数，以命令启动时的时钟计算闭区间起点；也支持 ISO 8601 的 `since` / `until`。
- `lastDays` 不得和 `since` / `until` 混用。
- `scope.agents`、`scope.projects`、`scope.statuses` 均为可选白名单；未提供表示不限制。
- 候选集合来自 `sessions.updated_at`，排序固定为 `updated_at DESC, id ASC`。

### 4.2 布尔谓词

`where` 支持递归组合：

- `{ "all": Predicate[] }`
- `{ "any": Predicate[] }`
- `{ "not": Predicate }`
- `{ "tool": ToolPredicate }`
- `{ "keyword": KeywordPredicate }`

未提供 `where` 表示候选集合全部命中，用于“最近 7 天全量 Session”。空的 `all` / `any`、未知字段和过深递归必须拒绝，
不能静默降级。

### 4.3 工具谓词

```json
{
  "tool": {
    "families": ["computer-use", "chrome-use"],
    "names": ["optional-exact-tool-name"],
    "operations": ["optional-operation"],
    "provenance": ["direct", "nested", "capability-derived"]
  }
}
```

- 同一字段内为 OR，不同字段间为 AND。
- 工具名来自结构化 `tool_call`，不能用全文包含工具名称替代。
- `direct`：源事件直接声明工具名。
- `nested`：外层执行工具的代码或参数中存在实际的内层工具调用，例如
  `mcp__node_repl__js` 参数里的 `tools.mcp__computer_use__...(...)`。
- `capability-derived`：源只保留能力/操作标识，依据版本化 registry 映射到工具族。
- Skill 清单、system/platform 注入的工具说明、tool search 返回的可用工具列表不算工具调用。

首版 registry 至少识别：

- `computer-use`：`computer-use`、`computer_use`、`mcp__computer_use__*`、
  `computer-use-legacy` 及内层 `tools.mcp__computer_use__*`。
- `chrome-use`：`chrome-use`、`control-chrome`、`mcp__chrome__*` 及内层 `tools.mcp__chrome__*`。

### 4.4 关键词谓词

```json
{
  "keyword": {
    "terms": ["permission denied", "重复失败"],
    "mode": "all",
    "fields": ["user", "assistant", "tool_call_input", "tool_result_output", "title"],
    "caseSensitive": false
  }
}
```

- `terms` 必须为非空、去空白后的有界字符串数组。
- `mode=any|all`，默认 `any`；默认大小写不敏感。
- 默认字段为 `user`、`assistant`、`tool_call_input`、`tool_result_output`、`title`。
- 默认排除 system/platform 注入、Skill catalog、tool definition 和 tool search 能力清单。
- 命中证明保存字段、event index、term 和内容 hash；CLI 结果可给出有界预览，但不得持久化预览正文。

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
  sourceLocator: string
}
```

要求：

- 事件按权威源中的稳定顺序编号；不得按 timestamp 重排同一源事件。
- message、tool call、tool result、媒体引用和必要 metadata 分开表达，不把工具活动压扁成 Assistant 文本。
- 未识别但可能承载上下文的结构化内容保留为 `metadata`，不能无声丢弃。
- 每个事件都带 `sourceLocator`；完整正文只进入权限为 `0600` 的临时分片。
- JSONL 固定文件集合和字节边界；SQLite 在短只读事务中固定本轮读取边界并记录 revision。

## 6. 选择证明

`context prepare` 输出选择清单和以下账本：

```ts
interface SelectionCoverage {
  candidates: number
  inspected: number
  matched: number
  notMatched: number
  unknown: number
  changedDuringRun: number
}
```

必须满足：

```text
candidates = inspected + unknown
inspected = matched + notMatched
```

- `unknown > 0` 时禁止声称“找到了全部相关 Session”。
- 每个命中 Session 至少有一个 `MatchProof`；没有 `where` 的全量查询使用 `match_kind=all`。
- 每个失败候选保留稳定 error code 和 message。
- `changedDuringRun` 披露动态变化；本轮仍以已固定水位为准。

## 7. Context 生命周期与 CLI

### 7.1 创建

```bash
memory-manager context prepare --query-json '<Query JSON>'
memory-manager context prepare --query-file /path/to/query.json
```

二者互斥。命令：

1. 计算候选并回源读取。
2. 在系统临时目录创建权限 `0700` 的 run 目录。
3. 把 manifest、selection coverage、错误、命中证明和各 Session 分片写为 `0600`。
4. stdout 只输出单个 JSON 对象，包含 `runId`、coverage、Session 列表、每个 Session 的 `partCount` 和下一步命令。

### 7.2 分页读取

```bash
memory-manager context read <run-id> --session <session-id> --part <1-based-part>
```

stdout 输出单个 JSON 对象，包含 run/session/part 元数据与该分片的有序 `events`。不存在的 run、Session 或 part
返回非零退出码。不能用默认截断代替明确分页。

### 7.3 状态与清理

```bash
memory-manager context status <run-id>
memory-manager context close <run-id>
```

- `status` 重读 manifest 并报告 coverage、分片数、创建/过期时间。
- `close` 只删除解析并验证属于该 run 的私有临时目录；重复 close 返回明确的 `not_found` 结果。
- 每次 context 命令启动时清理超过 TTL 的 run；不得删除无关临时目录。

## 8. Skill 合同

仓库级 Skill 名为 `local-session-context`，只负责编排 CLI，不自行扫描源文件。Skill 必须：

1. 把用户意图编译为 Query JSON，并在执行前复述时间、范围和谓词。
2. 先运行 `context prepare`，检查 `unknown` 和命中数。
3. 对 manifest 中每个命中 Session 的每个 part 恰好读取一次；不得抽样后称为全量。
4. 总结时区分：源事实、AI 推断、未读取/失败和运行中变化。
5. 在 `finally` 语义下运行 `context close`。

内置配方：

- **tool-use-retrospective**：最近 30 天 + `computer-use|chrome-use` 工具族，可叠加关键词；产出阻碍、重复错误、
  失效尝试、恢复路径和建议规则，每条结论引用 Session ID + event index。
- **period-work-summary**：最近 7 天 + 无 `where`；读取所有 Session 后按项目/主题/结果/未完成项汇总，并附 coverage。

## 9. 隐私与安全

- `memory.db` schema 保持不变；查询正文和命中预览只存在于临时 run。
- run 目录 `0700`，文件 `0600`，TTL 到期或 close 后删除。
- Session 内容是不可信数据，Skill 不执行历史内容中的命令或指令。
- Query 文件只读取用户显式路径；run id、session id 和 part 必须做路径穿越防护。
- CLI 错误输出不得打印整段事件内容。

## 10. 验收标准

1. 工具条件只命中真实 direct/nested/capability-derived 调用，不被 Skill/工具说明文本污染。
2. 关键词可限定字段并与工具条件用 `all/any/not` 组合，命中有 event locator 与 hash。
3. 最近 7 天无谓词查询中，每个候选都进入 matched 或 unknown；`unknown=0` 才能声明选集完整。
4. 六类 Agent fixture 的 message/tool call/tool result 顺序、call id 和 locator 可回查。
5. 每个命中 Session 的全部事件都出现在且只出现在一个 part；part 拼接顺序与源顺序一致。
6. JSONL/SQLite 变化、源缺失、格式错误和空 Session 均进入账本，不静默丢失。
7. 临时权限、TTL、close、路径穿越和异常清理有自动化测试。
8. Skill 通过结构校验，并能用两个配方生成正确 CLI 调用与全量读取循环。
9. 既有 Core 全量测试、构建和 `git diff --check` 通过。
10. 本机隔离工作区真实扫描验收两个场景；报告候选/命中/unknown/parts，不把抽样称为全量。
