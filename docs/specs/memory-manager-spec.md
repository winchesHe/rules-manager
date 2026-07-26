# memory-manager CLI 总规格

## 1. 概述

`memory-manager` 是一个本地优先的 CLI 工具，用于收集本机 AI agent 的历史 session，将 session 按项目分类，并借助 LLM 生成长期可复用的 rules 文档。

工作区固定为：

```text
~/.memory-manager
```

核心目标：

1. 收集本地 agent session。
2. 支持增量和全量扫描。
3. 根据项目分类 session。
4. 基于 session 生成项目 rules、全局 rules、个人风格文档。
5. 通过置信系统控制 rules 是否可信。
6. 输出简洁 Markdown，供人和 agent 使用。

## 2. 非目标

MVP 不做以下能力：

1. 不修改原始 agent session 文件。
2. 不默认上传完整 session content。
3. 不在 DB 中保存完整对话、tool output 或完整 LLM prompt/response。
4. 不默认创建复杂目录，例如 `logs/`、`cache/`、`snapshots/`。
5. 不把中低置信候选输出到正式 Markdown。
6. 不把项目事实混入全局 rules 或个人风格文档。

## 3. 工作区结构

MVP 工作区结构：

```text
~/.memory-manager/
  memory.db
  config.toml
  rules/
    global.md
    personal-style.md
    projects/
      <project-key>.md
```

路径说明：

| 路径 | 作用 |
| --- | --- |
| `memory.db` | 内部状态库，保存索引、hash、项目归类、候选规则、置信度和 evidence pointer |
| `config.toml` | 保存长期配置，例如 custom source 和 LLM 参数 |
| `rules/global.md` | 跨项目通用 rules |
| `rules/personal-style.md` | 用户个人偏好与交互风格 |
| `rules/projects/<project-key>.md` | 单项目 rules |

MVP 不默认创建：

```text
logs/
cache/
snapshots/
review.md
evidence.jsonl
```

## 4. 内置 Agent

内置 agent 基于本地真实 fixture，只保留：

```text
claude
codex
copilot
cursor
```

不作为当前内置 agent：

```text
kiro
pi
```

如果后续新增真实 source，可以再通过 adapter 扩展支持。

## 5. 配置文件

`config.toml` 只保存需要长期复用的配置，不保存每次命令的临时选择。

### 5.1 Custom Source

用户通过 `scan` 选择 custom path 后，可以保存到配置：

```toml
[[custom_sources]]
name = "my-claude-source"
agent = "claude"
path = "/path/to/sessions"
enabled = true
```

### 5.2 LLM 配置

LLM 固定由代码内部通过 `pi-code-agent` SDK 调用，不在配置中暴露 SDK 字段。

默认接入按 LiteLLM 风格使用：

```toml
[llm]
mode = "openai-response" # openai-response / openai-chat
model = "gpt-5.4"
effort = "high"          # low / medium / high
```

后续可按需要增加高级项：

```toml
temperature = 0
max_output_tokens = 8192
```

## 6. 数据库存储原则

`memory.db` 是内部状态库，不是内容仓库。

DB 保存：

```text
session id
agent
source path
updated_at
content_hash
project_key
project hints
rule candidates
confidence
user accept/reject
evidence pointer
run summary
LLM run metadata
```

DB 不保存：

```text
完整 user message
完整 assistant message
完整 tool output
完整 session dump
完整 LLM prompt/response
```

需要读取内容时，通过 `source_path` 回源读取。

## 7. Scan 设计

### 7.1 交互模式

```bash
memory-manager scan
```

交互选择：

```text
claude
codex
copilot
cursor
custom path
```

### 7.2 非交互模式

```bash
memory-manager scan --agent claude,codex
memory-manager scan --source test/sources --all
memory-manager scan --agent custom --path /path/to/source
memory-manager scan --full
```

### 7.3 Custom Path

custom path 流程：

1. 检查路径是否存在。
2. 对路径运行各 adapter 的 `probe`。
3. 判断该路径是否包含可识别 session。
4. 用户确认 adapter。
5. 将 custom source 保存到 `config.toml`。

### 7.4 Scan 状态

每个 session 的扫描状态：

| 状态 | 条件 |
| --- | --- |
| `new` | `session_id` 不存在 |
| `updated` | `updated_at` 变化 |
| `updated` | `content_hash` 变化 |
| `unchanged` | `updated_at` 和 `content_hash` 都不变 |
| `missing` | 源文件消失，默认保留索引 |
| `error` | 解析或归一化失败 |

增量扫描只处理 `new` 和 `updated`。

全量扫描重读全部 source，重算 hash 和项目分类。

## 8. Adapter 设计

每个 agent adapter 负责理解自己的 source 格式。

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

职责边界：

| 模块 | 职责 |
| --- | --- |
| Adapter | 理解 agent source，发现 session，解析 session，提取项目线索 |
| Project Classifier | 聚合 `ProjectHint`，计算项目归类 |
| Rule Generation | 回源读取内容，构造 evidence bundle，调用 LLM 生成候选规则 |

## 9. 真实 Source 测试

本地 fixture：

```text
test/sources/
  claude/
  codex/
  copilot/
  cursor/
```

硬性分类预期：

| agent | expected project |
| --- | --- |
| `claude` | `Boarding_Desktop` |
| `codex` | `cloud-code-master` |
| `copilot` | `agent-memory-system` |
| `cursor` | `moego-chrome-extension` |

测试不要求真实项目路径存在，可以根据 source 内容和路径字符串分类。

## 10. ProjectHint

`ProjectHint` 是 adapter 提供给 project classifier 的轻量项目线索。

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

评分优先级：

```text
git_root > cwd > source_project_path > message_path > branch
```

`unknown` 项目不参与正式项目 rules。

## 11. LLM Orchestration

LLM 是独立模块。

调用链路：

```text
memory-manager -> pi-code-agent SDK -> LiteLLM 风格接入
```

LLM 任务：

```text
extract_rules
merge_rules
render_markdown
```

MVP 可以合并：

```text
extract_rules + merge_rules -> 一次调用
render_markdown -> 单独调用
```

LLM 输入不是完整 session，而是经过裁剪和脱敏的 `EvidenceBundle`。

### 11.1 EvidenceBundle

```ts
type EvidenceBundle = {
  target: "project" | "global" | "personal_style";
  mode: "incremental" | "full";
  project?: {
    key: string;
    slug: string;
    rootPath?: string;
  };
  sessions: Array<{
    sessionId: string;
    agent: AgentName;
    projectKey?: string;
    updatedAt: string;
    excerpts: Array<{
      locator: string;
      role: "user" | "assistant" | "tool" | "system" | "unknown";
      text: string;
      reason: string;
    }>;
  }>;
  repoFacts?: Array<{
    sourcePath: string;
    locator: string;
    text: string;
    reason: string;
  }>;
  existingRules?: Array<{
    id: string;
    scope: string;
    projectKey?: string;
    ruleText: string;
    status: string;
    confidenceLevel: string;
  }>;
};
```

`excerpts` 只作为本次 LLM 输入，不写入 DB。

### 11.2 Excerpt Selection

选择片段的优先级：

1. 用户明确说“规则”“以后”“不要”“必须”“偏好”。
2. 涉及命令、测试、构建、发布、调试。
3. 涉及路径、目录、配置、项目结构。
4. 用户纠正 assistant。
5. 多次重复出现的行为。
6. assistant 总结只作为低优先级。

### 11.3 LLM 输出校验

LLM 输出必须是结构化 JSON。

本地必须执行：

1. JSON parse。
2. Schema validate。
3. Evidence pointer validate。
4. Scope validate。
5. 有限重试。

无 evidence 的 candidate 必须拒绝。

## 12. Rule Generation

生成流程：

```text
changed/full sessions
  -> 回源读取 source content
  -> excerpt selection
  -> redaction
  -> LLM extract/merge
  -> schema validation
  -> evidence pointer validation
  -> 写入 rule_candidates
```

三类 rules：

| scope | 内容 |
| --- | --- |
| `project` | 项目事实、命令、约束、工作流 |
| `global` | 跨项目稳定规则或用户明确全局偏好 |
| `personal_style` | 用户交互偏好，不包含项目事实 |

## 13. Confidence System

置信系统不使用 P0-P6。

核心规则：

```text
没有 evidence -> rejected
用户 accept -> verified
用户 reject -> rejected
与 verified 冲突 -> needs_review
unknown session 不能生成 high 项目 rule
单项目事实不能生成 high global rule
```

置信等级：

```text
low
medium
high
verified
```

正式输出只使用：

```text
high
verified
```

加分因子：

```text
用户明确要求
repo 文件/脚本/CI 证据
多 session 重复
多 agent 重复
项目分类置信高
用户 accept
```

降分因子：

```text
assistant-only
弱推断
source missing
project unknown
冲突
太泛泛
无 evidence
```

## 14. Renderer

Renderer 输出：

```text
rules/global.md
rules/personal-style.md
rules/projects/<project-key>.md
```

Renderer 阶段可以调用 LLM 做最终 Markdown rewrite。

P0-P6 只用于最终文案优化：

| 准则 | 含义 |
| --- | --- |
| P0 | Token cost，保留值得长期占用上下文的内容 |
| P1 | Proximity，条件、动作、限制放在一起 |
| P2 | Specificity，使用具体命令、路径、动作 |
| P3 | Guardrails，优先写边界和禁止项 |
| P4 | Density，压缩重复表达 |
| P5 | Markdown style，标准 Markdown，命令和路径用反引号 |
| P6 | Verifiability，规则尽量可 yes/no 检查 |

Renderer 限制：

```text
不能新增无证据 rule
不能改变事实含义
只能压缩、合并、重排、优化表达
```

## 15. Safety

默认安全策略：

1. DB 不存完整 content。
2. LLM 前做 secret redaction。
3. LLM prompt/response 不默认落盘。
4. `--debug` 不默认打印完整 session。
5. 支持 `--dry-run`。
6. 测试默认使用 mock LLM。

## 16. MVP 验收链路

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
5. 正式 Markdown 只包含 `high` 和 `verified`。
6. P0-P6 只用于最终 Markdown 文案优化。

## 17. 后续实现顺序

建议按最小可验证链路实现：

1. `init` 和最小工作区。
2. SQLite schema 和轻量状态写入。
3. 4 个 adapter 的 `probe/discover/parse/extractProjectHints`。
4. 基于 `test/sources` 的分类测试。
5. `scan` 增量和全量。
6. LLM client，固定通过 `pi-code-agent` SDK。
7. rule generation 和 confidence system。
8. renderer 输出 `rules/*.md`。
9. review、accept、reject、explain 命令。
