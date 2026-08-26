# global-instruction-management

## 概述

为 Claude、Codex、Copilot、Cursor、OpenCode、Pi 六个内置 agent 提供统一的主要全局 instruction 入口。首版只做只读发现与按需查看，每个 agent 最多展示一个主来源。

核心目标：

1. `rules list` 只列六个 agent 的主要全局 instruction 来源、路径与存在性。
2. `rules show <agent>` 直接读取该 agent 的唯一主来源正文到 stdout，内容不落 DB、不复制文件。
3. 支持主来源文档化的 config home 环境变量与默认目录。
4. Cursor User Rules 无稳定公开文件 API，返回明确 capability，不依赖私有 SQLite key。

## 非目标

MVP 不展示或处理以下辅助来源：

1. Claude managed policy 和 `rules/**/*.md`。
2. Codex `AGENTS.override.md`。
3. Copilot `instructions/**/*.instructions.md` 和 `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`。
4. OpenCode Claude fallback 和 `opencode.json(c)` 的 `instructions[]` capability。
5. Pi `SYSTEM.md` 和 `APPEND_SYSTEM.md`。
6. repository、cwd、nested `AGENTS.md`、`.cursor/rules` 或其他项目级来源。
7. 客户端内建 system prompt、Cursor 私有 DB、云端 Team/Organization Rules。
8. apply/edit/switch/disable、live 文件修改、备份或 prompt preset DB。
9. 旧 Plan 05/06/07 的规则生成、审核和 renderer。

## 主要来源矩阵

| Agent | Source id | 路径 / 能力 | 说明 |
|---|---|---|---|
| Claude | `instructions` | `${CLAUDE_CONFIG_DIR:-~/.claude}/CLAUDE.md` | 用户级主指令 |
| Codex | `instructions` | `${CODEX_HOME:-~/.codex}/AGENTS.md` | 用户级主指令；不展示 override |
| Copilot | `instructions` | `~/.copilot/copilot-instructions.md` | 用户级主指令 |
| Cursor | `user-rules` | `null` | Customize → Rules；返回 `unsupported` |
| OpenCode | `instructions` | `${XDG_CONFIG_HOME:-~/.config}/opencode/AGENTS.md` | 用户级主指令 |
| Pi | `instructions` | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/AGENTS.md` | 用户级主指令 |

Copilot CLI 的运行时 `--config-dir` 无法从其他进程恢复，首版 CLI 只使用默认根；测试通过隔离 `homeDir` 覆盖该路径。

## 数据模型

不修改 SQLite schema。所有结果只存在于进程内存和 stdout。

```ts
type GlobalInstructionSource = {
  id: 'instructions' | 'user-rules'
  agent: AgentName
  scope: 'global'
  kind: 'instructions' | 'ui-capability'
  path: string | null
  format: 'markdown' | 'ui'
  status: 'present' | 'missing' | 'unsupported'
  effective: boolean
  discoveredFrom: 'default' | 'environment' | 'capability'
  note?: string
}
```

结果按 `agent / id / path` 使用代码点稳定排序。固定主来源即使不存在也返回 `missing`，让调用者看到完整能力矩阵。

## 接口设计

```bash
# 列出六 agent 的全部主要全局来源 metadata
memory-manager rules list

# 只列指定 agent
memory-manager rules list claude

# 查看指定 agent 的主要来源正文
memory-manager rules show claude
```

`rules list [agent]` 输出格式化 JSON，未知 agent 非零退出。

`rules show <agent>` 重新执行同一 locator，直接选择该 agent 的唯一主来源，只允许读取当前仍存在的 Markdown 文件。missing 和 unsupported source 不允许 show；接口不接受 source id 或文件路径。

```ts
function listGlobalInstructionSources(options?: {
  agent?: AgentName
  homeDir?: string
  env?: NodeJS.ProcessEnv
}): GlobalInstructionListResult

function showGlobalInstructionSource(
  agent: AgentName,
  options?: { homeDir?: string; env?: NodeJS.ProcessEnv },
): GlobalInstructionShowResult
```

该功能不要求 memory-manager workspace 已初始化，因为它不访问 workspace DB。全局 `--workspace` 不改变 agent home；测试通过内部 `homeDir/env` 隔离。

## 发现与安全规则

1. agent config 根只按文档化环境变量和用户 home 解析；返回绝对路径。
2. 每个 agent 最多返回一个固定主来源；辅助来源不返回 metadata，show 也没有选择辅助来源的参数。
3. Cursor 始终返回单条 `unsupported` capability，list 成功但 show 明确失败。
4. 可 show 文件上限 1 MiB，必须是 UTF-8 文本；超限、不可读或读取中变化均明确报错。
5. list 只输出路径与 metadata；show 正文只进入内存和 stdout，不写日志、不写 DB、不生成副本。
6. show 只接受 agent，不接受 source id 或 path。
7. 读取前后对目标文件做 stat 一致性检查；agent live 文件 hash 在命令前后必须不变。
8. 主来源可以是文件 symlink，list 保留显示路径，show 跟随到文件目标；不进行目录遍历。

## 改动范围

- `src/global-instructions.ts`：六 agent 主来源 locator、统一类型、排序和 show 安全读取。
- `src/commands/rules.ts`：list/show runner，输出 JSON。
- `src/cli.ts`：注册 `rules list [agent]` 与 `rules show <agent>`。
- `test/unit/global-instructions.test.ts`：临时 home/env fixture 覆盖六 agent、辅助来源排除、限制和只读性。
- `test/unit/cli-options.test.ts`：黑盒覆盖 list/show、未知 agent 和无需 init。
- `memory/process.md`：同步范围调整和验收证据。

## 风险

- Cursor 无稳定全局文件 API，因此只返回 unsupported capability。
- Codex override 等辅助文件可能改变 agent 实际加载结果，但本产品边界有意只展示主入口，不计算最终 effective prompt。
- show 会输出用户主指令正文，因此只按固定 source id 显式调用，并且不落日志和 DB。
- 未来开放写入必须另写 spec，包含 compare-and-swap、备份与冲突处理。

## 验收链路

```bash
npm test -- --runInBand test/unit/global-instructions.test.ts
npm test -- --runInBand test/unit/cli-options.test.ts
npm test -- --runInBand
npm run build
node dist/cli.js rules list
node dist/cli.js rules show claude
git diff --check
```

必须证明：

1. 六个 agent 都有稳定 list 结果，每个 agent 恰好一个主来源；Cursor 为 unsupported。
2. list 不出现 managed policy、override、模块规则、custom rules、config capability、fallback、SYSTEM 或 APPEND_SYSTEM。
3. show 不提供辅助 source id 或任意 path 入口。
4. show 拒绝多余参数、missing/unsupported source 和超限文件。
5. list/show 前后 fixture 文件 hash 不变，不创建 workspace，命令不要求 init。
6. stdout list 不含规则正文；show 只包含指定主来源正文。
7. 本机六个 agent smoke 每个最多列一个来源，抽样 show 后源文件 hash 不变。

## 后续实现顺序

1. 测试先约束每个 agent 只返回主要来源，并覆盖辅助 source id 不可 show。
2. 删除辅助 locator、目录遍历和状态机，只保留六个主入口。
3. 全量测试、构建和本机只读 smoke；同步 `memory/process.md`。
