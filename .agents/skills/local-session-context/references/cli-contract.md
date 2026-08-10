# CLI 与 Query v2 合同

## CLI 入口

优先使用已安装命令：

```bash
memory-manager <command>
```

在 memory-manager 仓库内且命令未安装时，先构建再使用仓库产物：

```bash
npm run build -w @memory-manager/core
node packages/core/dist/cli.js <command>
```

不要绕过 CLI 直接读取 Session 源；Query 与 Context 必须共享同一次固定水位。

```bash
memory-manager context prepare --query-json '<json>'
memory-manager context prepare --query-file /absolute/path/query.json
memory-manager context status <run-id>
memory-manager context sessions <run-id> [--cursor <cursor>] [--limit <1-200>]
memory-manager context outcomes <run-id> [--status matched|not_matched|unknown] [--cursor <cursor>] [--limit <1-200>]
memory-manager context proofs <run-id> --session <session-id> [--cursor <cursor>] [--limit <1-200>]
memory-manager context locate <run-id> --session <session-id> --event <index>
memory-manager context read <run-id> --session <session-id> --part <n>
memory-manager context close <run-id>
```

`--query-json` 与 `--query-file` 互斥。分页响应存在 `nextCursor` 时继续请求，直到该字段消失。

## Query JSON v2

```json
{
  "version": 2,
  "time": { "lastDays": 30 },
  "scope": {
    "agents": ["claude", "codex", "copilot", "cursor", "opencode", "pi"],
    "projects": ["optional-project-slug"],
    "statuses": ["new", "updated", "unchanged"],
    "includeInternal": false
  },
  "where": {
    "all": [
      { "usedTool": { "families": ["computer-use", "chrome-use"] } },
      {
        "mentions": {
          "terms": ["联调"],
          "mode": "any",
          "fields": ["message"],
          "origins": ["human_user", "assistant_output"],
          "caseSensitive": false
        }
      }
    ]
  }
}
```

时间：`lastDays` 为正整数；也可使用 ISO 8601 `since` / `until`，但不能和 `lastDays` 混用。

范围：`scope` 可省略；Agent 只允许 `claude|codex|copilot|cursor|opencode|pi`。`includeInternal` 默认 false。未明确要求状态限制时，不要自行添加 `statuses`。

布尔谓词：

- `all`：任一子项未命中则未命中；没有未命中但存在 unknown 时为 unknown。
- `any`：任一子项命中即命中；无命中但存在 unknown 时为 unknown。
- `not`：保留 unknown，不把无法判断翻转成命中。
- 省略 `where`：时间/范围内所有可读 Session 都命中。

`usedTool` 表示结构化工具使用：

- `families`：常用值 `computer-use`、`chrome-use`。
- `names`：精确工具名。
- `operations`：如 `click`、`screenshot`、`navigate`。
- `provenance`：`direct|nested-ast|capability-derived`。
- 同一字段内 OR，不同字段间 AND。
- `nested-ast` 只认 AST 调用表达式；补丁、字符串、注释、fixture 不命中。疑似调用但代码无法解析时返回 unknown。

`mentions` 表示文本提及：

- `terms` 的 `mode` 为 `any|all`。
- `fields` 为 `message|tool_call_input|tool_result_output|title`，默认只有 `message`。
- `origins` 默认只有 `human_user|assistant_output`。
- 其他可显式指定的 origin：`tool_runtime|developer_instruction|host_context|skill_instruction|internal_job|historical_forward|unknown`。一般不要扩到注入来源。

## 配方一：computer-use / chrome-use / 联调复盘

用户问“找到最近 30 天 computer-use、chrome-use、联调相关的 session，并总结踩坑与快速联调经验”时使用：

```json
{
  "version": 2,
  "time": { "lastDays": 30 },
  "where": {
    "all": [
      {
        "any": [
          { "usedTool": { "families": ["computer-use", "chrome-use"] } },
          {
            "mentions": {
              "terms": ["computer-use", "chrome-use"],
              "mode": "any"
            }
          }
        ]
      },
      { "mentions": { "terms": ["联调"], "mode": "any" } }
    ]
  }
}
```

这个配方要求 Session 同时与目标工具和“联调”相关，避免把所有普通浏览器操作都召回；工具相关性可以来自真实调用，也可以来自真人/助手消息里的明确讨论。汇总时必须按 proof 区分：

- `tool_usage`：可以写“实际使用”。
- `mention`：只能写“讨论/提到”，需要从上下文确认是否真的操作过。

若用户只要真实调用，使用：

```json
{
  "version": 2,
  "time": { "lastDays": 30 },
  "where": {
    "usedTool": { "families": ["computer-use", "chrome-use"] }
  }
}
```

读取完成后重点关联同 `toolCallId` 的 call/result、相同步骤的重试、相同错误、阻塞任务继续的权限/环境/页面状态/工具限制，以及失败后的有效恢复动作。

## 配方二：最近 7 天全量总结

```json
{
  "version": 2,
  "time": { "lastDays": 7 }
}
```

不要添加 `where`。必须分页读完 `context sessions` 的所有 Session，并读取每个 Session 的所有 part；`coverage.unknown` 对应项通过 `context outcomes --status unknown` 读完并列入限制。

## Coverage、分页与完整读取

这里的“完整读取”是指读取固定水位内的全部标准化语义事件，不是逐字节复制 Agent 的底层存储。消息、工具调用、
工具结果、媒体引用及必要 metadata 会保序提供；Codex Reader 以 `response_item` 为权威记录，去除 `event_msg`、
`turn_context` 等重复宿主视图，以及 token 计数、工具定义和 encrypted reasoning。每个保留事件都有
`sourceLocator`，需要审计时可回查原始源。

prepare/status 只返回有界摘要：

```json
{
  "runId": "...",
  "coverage": {
    "candidates": 0,
    "inspected": 0,
    "matched": 0,
    "notMatched": 0,
    "unknown": 0,
    "unknownSource": 0,
    "unknownOrigin": 0,
    "unknownToolParse": 0,
    "changedDuringRun": 0
  },
  "sessionCount": 0,
  "limitations": []
}
```

核对：

```text
candidates = inspected + unknown
inspected = matched + notMatched
unknown = unknownSource + unknownOrigin + unknownToolParse
```

`context sessions`、`context outcomes` 和 `context proofs` 返回：

```json
{
  "total": 1,
  "returned": 1,
  "cursor": "0",
  "nextCursor": "50",
  "items": []
}
```

`nextCursor` 缺失才表示分页结束。维护两个账本：

```text
session_id | expected_parts | read_parts | complete
event_hash | expected_segments | read_segments | complete
```

每个 `context read` part 都带 `payloadBytes` 和 `payloadHash`，CLI 读取时会验证落盘内容完整性。普通事件直接出现在 `events`；超大事件以 `event_segment` 跨 part 连续出现，按 `segmentIndex` 收齐，不能把单个 segment 当成完整 event。
临时 run 内部把一个 Session 的所有 part 压缩在单一私有容器中；这是存储细节，不改变 part 编号和读取命令。

`context sessions` 为防止 proof 数量导致输出截断，只返回 `proofCount`、按 kind 聚合的 `proofKinds` 和 `toolFamilies`；完整 proof 必须通过 `context proofs` 分页读取。`context locate` 把 proof 的 event index 映射到 `firstPart..lastPart`，并给出包含前后邻接上下文的 `suggestedFromPart..suggestedToPart`。

联调复盘允许只读取全部相关 proof 的合并邻域，但必须称为“证据上下文”；最近 7 天全量总结或用户明确要求完整 Session 时，仍须读取所有 part。

## 错误处理

- scan 有错误：记录扫描不完整，不声称候选集合完整。
- `unknownSource>0`：来源缺失、损坏或不支持；读取 unknown outcome 的错误码。
- `unknownOrigin>0`：关键词只出现在无法判定来源的消息；不当作命中或未命中。
- `unknownToolParse>0`：疑似嵌套工具调用无法解析；不当作未命中。
- read 失败：重试一次；仍失败则记录 Session/part，最终报告未读范围。
- `changedDuringRun>0`：本轮使用冻结水位，源在读取期间发生变化。
- 输出过大：继续逐 part/逐页读取；禁止 `head`、抽样或批量拼接截断。
- 任意失败后仍执行 `context close`；close 失败时报告 run id 供人工清理。
