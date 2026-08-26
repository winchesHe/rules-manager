# agent-auto-memory-read

## 概述

为 Claude 与 Codex 的本地自动记忆提供统一、只读的发现和查看命令。该能力与 `rules` 分离：`rules` 表示用户维护的持久化 instruction，`memories` 表示 agent 自动生成的记忆。

核心目标：

1. `memories list [agent]` 只列自动记忆主入口的 metadata，不输出正文。
2. `memories show <agent> [memory-id]` 只读取 locator 当前发现的主入口正文，不接受任意路径。
3. Claude 按项目列出 `MEMORY.md`；Codex 从公开 `MEMORY.md` 的 `applies_to.cwd` 派生只读项目视图，
   不依赖私有 SQLite schema。
4. 命令不要求 memory-manager workspace init，不访问或修改 DB。

## 非目标

MVP 不做以下能力：

1. 不读取项目 `CLAUDE.md`、`CLAUDE.local.md`、`AGENTS.md` 或 rules，它们属于 instruction，不是自动记忆。
2. 不展开 Claude memory topic 文件，只读取各项目的 `memory/MEMORY.md` 主入口。
3. 不展开 Codex `memory_summary.md`、`raw_memories.md`、`rollout_summaries/` 或 skills，只读取 `memories/MEMORY.md` 主入口。
4. 不读取 Codex `memories_1.sqlite`、`state_5.sqlite` 等私有 schema，也不从 thread/session 数据猜项目；
   项目范围只接受 `MEMORY.md` 自身显式声明的 `applies_to.cwd`。
5. 不编辑、删除、生成或合并任何 agent memory。
6. 不把 memory 正文写入 memory-manager DB、日志、缓存或副本。
7. 不扩展到其他 agent；其本地自动记忆路径缺少稳定公开契约。

## 来源模型

### Claude

配置根：`${CLAUDE_CONFIG_DIR:-~/.claude}`。

扫描 `<config>/projects/*/memory/MEMORY.md`，每个现存普通文件或文件 symlink 返回一条 source：

```text
id: project:<projects 子目录名>
agent: claude
scope: project
path: <config>/projects/<encoded-project>/memory/MEMORY.md
status: present
```

Claude 官方说明该目录按 git repository 隔离并跨 worktree 共享，但没有公开 encoded project 目录名的稳定编码算法。因此首版不从 cwd 猜目录，也不尝试反解项目路径；调用者先 list，再用返回的 memory id show。

### Codex

配置根：`${CODEX_HOME:-~/.codex}`。

只报告官方公开主入口 `<config>/memories/MEMORY.md`：

```text
id: memory
agent: codex
scope: global
path: <config>/memories/MEMORY.md
status: present | missing
```

Codex 官方当前将本地 memories 放在统一 store 中，没有公开稳定的 per-project 文件映射。保留该跨项目
合并 source，同时解析其中 `# Task Group` 的 `applies_to: cwd=...`，派生 `scope: project` 的虚拟只读
source。虚拟 source 的 `path` 仍指向统一 `MEMORY.md`，并携带 `projectPath` 与 `taskGroupCount`，不得
伪装成独立项目文件。

## 数据模型

不修改 SQLite schema。

```ts
type AutoMemoryAgent = 'claude' | 'codex'

type AutoMemorySource = {
  id: string
  agent: AutoMemoryAgent
  scope: 'project' | 'global'
  path: string
  format: 'markdown'
  status: 'present' | 'missing'
  discoveredFrom: 'filesystem' | 'default' | 'environment'
  note?: string
  projectPath?: string
  taskGroupCount?: number
}

type AutoMemoryListResult = {
  agent: AutoMemoryAgent | null
  count: number
  sources: AutoMemorySource[]
  errors: Array<{ agent: AutoMemoryAgent; path: string; message: string }>
}

type AutoMemoryShowResult = {
  source: AutoMemorySource
  content: string
}
```

结果按 `agent / scope / projectPath / id / path` 稳定排序。Claude 只返回现存项目 memory，不为所有未知
项目伪造 missing 槽位；Codex 固定槽位即使不存在也返回 missing，现存且可安全读取时再追加
`applies_to.cwd` 派生的项目 source。

## 接口设计

```bash
# 列出 Claude 与 Codex 自动记忆主入口
memory-manager memories list

# 按 agent 筛选
memory-manager memories list claude
memory-manager memories list codex

# agent 只有一条 source 时可省略 memory id
memory-manager memories show codex

# Claude 多项目时使用 list 返回的稳定 id
memory-manager memories show claude 'project:<encoded-project>'
```

行为约束：

1. `list [agent]` 只接受 `claude`、`codex`；未知或其他内置 agent 非零退出。
2. `show <agent> [memory-id]` 在该 agent 只有一条 present source 时允许省略 id。
3. source 为多条且未传 id 时明确报错并提示先执行 list，不自动猜当前项目。
4. 传入 id 必须精确匹配本轮 locator 结果；不能传 path。
5. missing source 不允许 show。
6. 输出沿用格式化 JSON；正文只出现在 show 的 `content`。

内部接口：

```ts
function listAutoMemorySources(options?: {
  agent?: AutoMemoryAgent
  homeDir?: string
  env?: NodeJS.ProcessEnv
}): AutoMemoryListResult

function showAutoMemorySource(
  agent: AutoMemoryAgent,
  memoryId?: string,
  options?: { homeDir?: string; env?: NodeJS.ProcessEnv },
): AutoMemoryShowResult
```

## 安全策略

1. Claude 只扫描 `projects` 的直接子目录，并检查固定相对路径 `memory/MEMORY.md`；不递归扫描 session、topic 或其他文件。
2. 不跟随项目目录 symlink；允许最终 `MEMORY.md` 是文件 symlink。
3. show 只接受 locator 返回的 memory id，不接受任意文件路径。
4. 单文件上限 1 MiB，必须是有效 UTF-8；读取前后 stat 必须一致。
5. list 为解析 Codex 项目 metadata 会在内存中读取公开 `MEMORY.md`，但不返回正文；show 正文只进入
   内存和 stdout。
6. 不 import DB/workspace 模块，不创建 `.memory-manager`。
7. Codex 私有 SQLite 即使存在也完全忽略。

## 改动范围

- `src/auto-memories.ts`：新增 Claude/Codex locator、统一类型、排序与安全 show。
- `src/commands/memories.ts`：新增 list/show runner 和 agent 校验。
- `src/cli.ts`：注册 `memories list [agent]` 与 `memories show <agent> [memory-id]`。
- `test/unit/auto-memories.test.ts`：临时 home fixture 覆盖多项目、Codex 固定槽位、私有 SQLite 忽略、限制与只读性。
- `test/unit/cli-options.test.ts`：黑盒覆盖无需 init、单条省略 id、多条必须 id 和非法 agent。
- `memory/process.md`：实现完成后同步行为与验收证据。

## 假设

- ⚠ Claude `<config>/projects/*/memory/MEMORY.md` 的目录层级保持官方文档当前契约；encoded project 名只作为不透明 id 使用。
- ⚠ Codex `~/.codex/memories/MEMORY.md` 的 `# Task Group`、`scope:` 与 `applies_to:` 仍是生成态文本格式；
  格式变化时项目视图可能为空，但全局主入口仍保留。
- ⚠ 项目视图依赖 Codex 已显式写出的绝对 `applies_to.cwd`，不从模糊描述、Session 或 repo 名猜测路径。

## 风险

- Auto memory 可能包含内部项目信息。兜底：list 不输出正文，show 必须显式指定 agent，Claude 多项目还需指定 locator id。
- Codex 文件布局仍处于新功能演进期。兜底：只依赖官方公开根和主入口；缺失时明确 missing，不降级读私有 DB。
- Claude 项目 id 不可读且不可无损反解。兜底：把它当不透明 id，不伪造 repo path；后续若官方开放映射再扩展。
- Memory 文件可能在 agent 后台更新。兜底：读取前后 stat 不一致立即失败，不输出可能撕裂的内容。

## 验收链路

```bash
npm test -- --runInBand test/unit/auto-memories.test.ts
npm test -- --runInBand test/unit/cli-options.test.ts
npm test -- --runInBand
npm run build
node dist/cli.js memories list
node dist/cli.js memories list claude
node dist/cli.js memories show claude '<list 返回的 id>'
git diff --check
```

必须证明：

1. Claude list 只返回各项目的 `memory/MEMORY.md`，不返回 topic、session 或 instruction 文件。
2. Claude 多项目 show 未传 id 时失败，传 list 返回 id 时只读取对应 memory。
3. Codex list 保留公开 `memories/MEMORY.md` 固定槽位，并为显式 `applies_to.cwd` 返回项目切片；私有
   SQLite 存在不改变结果。
4. 即使存在项目切片，`memories show codex` 仍直接读取全局 `memory` 主入口；项目切片必须使用稳定 id。
5. 任意 path、未知 id、非法 agent、missing、超限和非法 UTF-8 均明确失败。
6. list/show 前后 fixture hash 不变，不创建 workspace，不访问 memory-manager DB。
7. 本机 smoke 能列出 Claude 已有项目 memory；Codex 当前公开主入口缺失时如实返回 missing。

## 后续实现顺序

1. 测试先定义 Claude 多项目与 Codex 单固定槽位的 list/show 端到端骨架。
2. 实现只读 locator、memory id 选择和安全文件读取。
3. 注册 CLI，覆盖无需 init 与参数错误黑盒测试。
4. 全量验收、本机只读 smoke，并同步 `memory/process.md`。

## 参考

- Claude auto memory：https://code.claude.com/docs/en/memory#auto-memory
- Codex local memories：https://developers.openai.com/codex/customization/memories/
- 现有全局 instruction spec：`docs/specs/global-instruction-management.md`
