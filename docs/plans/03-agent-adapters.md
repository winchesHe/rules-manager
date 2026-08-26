# Plan 03: Agent Adapters

## 目标

基于合成 `test/sources` 实现 4 个内置 adapter：

```text
claude
codex
copilot
cursor
```

## Adapter 接口

```ts
type AgentAdapter = {
  name: AgentName;
  probe(path: string): Promise<ProbeResult>;
  discover(source: ScanSource): Promise<DiscoveredSession[]>;
  parse(discovered: DiscoveredSession): Promise<ParsedSession>;
  normalize(parsed: ParsedSession): Promise<NormalizedSession>;
  extractProjectHints(
    parsed: ParsedSession,
    discovered: DiscoveredSession
  ): Promise<ProjectHint[]>;
};
```

## 最小可验证链路

每个 adapter 至少支持：

1. `probe(test/sources/<agent>)` 能识别对应 agent。
2. `discover` 能找到真实 session 文件。
3. `parse` 能读取 session id、时间、基础消息数量。
4. `normalize` 能生成稳定 `session_id` 和 `content_hash`。
5. `extractProjectHints` 能提取项目线索。

## 真实 source 目标

| agent | source | 关键线索 |
| --- | --- | --- |
| `claude` | `test/sources/claude` | source path 编码项目路径，content 中有 `cwd` |
| `codex` | `test/sources/codex` | `session_meta.payload.cwd` |
| `copilot` | `test/sources/copilot` | `session.start.data.context.gitRoot/cwd` |
| `cursor` | `test/sources/cursor` | source path 编码项目路径 |

## ProjectHint

adapter 输出：

```ts
type ProjectHint = {
  kind:
    | "cwd"
    | "git_root"
    | "git_remote"
    | "source_project_path"
    | "message_path"
    | "branch";
  value: string;
  confidence: number;
  agent: AgentName;
  source: "metadata" | "source_path" | "message_text";
  locator?: string;
};
```

## 验收

每个 adapter 测试必须断言：

```text
probe matched = true
discover count >= 1
content_hash exists
ProjectHint count >= 1
```

## 渐进增强

后续增强：

1. 支持更多 source 版本。
2. 支持更细粒度 locator。
3. 支持 repo file/tool call 线索。
4. 支持 adapter parse error 的局部恢复。

## 非目标

本阶段不做：

1. 最终项目归类。
2. rules 抽取。
3. LLM 调用。
