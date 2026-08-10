# CLI 与 Query 合同

## 目录

- CLI 入口
- Query JSON v1
- 配方一：工具使用复盘
- 配方二：最近 7 天全量总结
- Coverage 与读取账本
- 错误处理

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

四个 Context 命令：

```bash
memory-manager context prepare --query-json '<json>'
memory-manager context prepare --query-file /absolute/path/query.json
memory-manager context read <run-id> --session <session-id> --part <n>
memory-manager context status <run-id>
memory-manager context close <run-id>
```

`--query-json` 与 `--query-file` 互斥。

## Query JSON v1

```json
{
  "version": 1,
  "time": { "lastDays": 30 },
  "scope": {
    "agents": ["claude", "codex", "copilot", "cursor", "opencode", "pi"],
    "projects": ["optional-project-slug"],
    "statuses": ["new", "updated", "unchanged"]
  },
  "where": {
    "all": [
      { "tool": { "families": ["computer-use", "chrome-use"] } },
      {
        "keyword": {
          "terms": ["联调", "permission denied"],
          "mode": "any",
          "fields": ["user", "assistant", "tool_call_input", "tool_result_output"],
          "caseSensitive": false
        }
      }
    ]
  }
}
```

时间：

- `lastDays` 为正整数。
- 或使用 ISO 8601 `since` / `until`。
- `lastDays` 不能和 `since` / `until` 同时出现。

范围：

- `scope` 全部可省略；省略表示不限制。
- Agent 只允许 `claude|codex|copilot|cursor|opencode|pi`。
- 未要求限制状态时不要默认排除 `new|updated|unchanged`；`missing|error` 会进入 unknown 证明。

谓词：

- `{"all":[...]}`：全部条件成立。
- `{"any":[...]}`：任一条件成立。
- `{"not":{...}}`：子条件不成立。
- `{"tool":{...}}`：结构化工具调用。
- `{"keyword":{...}}`：字段化关键词。
- 省略 `where`：时间/范围内全部 Session。

工具字段：

- `families`：常用值为 `computer-use`、`chrome-use`。
- `names`：精确工具名。
- `operations`：如 `click`、`screenshot`、`navigate`。
- `provenance`：`direct|nested|capability-derived`。
- 同一字段内 OR，不同字段间 AND。

关键词字段：

- `fields`：`user|assistant|tool_call_input|tool_result_output|title`。
- `mode`：`any|all`。
- 默认字段为以上全部；system/platform/Skill catalog 不参与。

## 配方一：工具使用复盘

只找真实使用过 computer-use 或 chrome-use 的最近 30 天 Session：

```json
{
  "version": 1,
  "time": { "lastDays": 30 },
  "where": {
    "tool": { "families": ["computer-use", "chrome-use"] }
  }
}
```

工具或关键词任一命中：

```json
{
  "version": 1,
  "time": { "lastDays": 30 },
  "where": {
    "any": [
      { "tool": { "families": ["computer-use", "chrome-use"] } },
      {
        "keyword": {
          "terms": ["浏览器联调", "chrome extension"],
          "mode": "any"
        }
      }
    ]
  }
}
```

要求“使用过工具且提到指定问题”时把 `any` 改成 `all`。不要擅自决定二者关系；从用户措辞判断，不明确时在执行说明中写明采用的关系。

读取完成后重点关联：

- tool call 与同 `toolCallId` 的 result。
- 同一步骤重复调用和相同错误。
- 阻止任务继续的权限、环境、页面状态、工具限制或源缺失。
- 失败后的恢复动作和最终是否恢复。

## 配方二：最近 7 天全量总结

```json
{
  "version": 1,
  "time": { "lastDays": 7 }
}
```

不要添加 `where`。prepare 返回的所有 `sessions` 都必须读取全部 part；`outcomes` 中的 unknown 必须列入限制。

## Coverage 与读取账本

prepare 的关键字段：

```json
{
  "runId": "...",
  "coverage": {
    "candidates": 0,
    "inspected": 0,
    "matched": 0,
    "notMatched": 0,
    "unknown": 0,
    "changedDuringRun": 0
  },
  "sessions": [
    {
      "id": "...",
      "agent": "codex",
      "eventCount": 0,
      "partCount": 0,
      "proofs": []
    }
  ],
  "limitations": []
}
```

核对恒等式：

```text
candidates = inspected + unknown
inspected = matched + notMatched
```

维护读取账本：

```text
session_id | expected_parts | read_parts | complete
```

只有所有非空 Session 的 `read_parts=expected_parts` 时，才称“完整读取命中上下文”。读取过程中可用 `context status` 恢复 part 计划。

## 错误处理

- scan 有错误：记录扫描不完整，不声称候选集合完整。
- prepare `unknown>0`：继续读取已命中项，限制选择完整性声明。
- read 失败：重试一次；仍失败则记录具体 Session/part，最终报告为未读。
- `changedDuringRun>0`：说明本轮使用冻结水位，源在读取期间发生过变化。
- 输出过大：继续逐 part 读取；不要用 `head`、抽样或批量拼接截断。
- 任意失败后仍执行 `context close`；close 失败时报告临时 run id 以便人工清理。
