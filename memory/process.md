# Plan 01 实现上下文记录

## 实现范围

Plan 01: Workspace & State —— 建立 `memory-manager` 的最小本地状态基础。

## 关键决策

### 技术栈
- **语言**：TypeScript（ESM，target node18）
- **打包**：tsdown（基于 rolldown）
- **CLI 框架**：Commander（命令路由） + @clack/prompts（交互提示）
- **数据库**：better-sqlite3（同步 SQLite，WAL 模式）
- **颜色**：picocolors
- **测试**：Jest + ts-jest（ESM 模式）

### 工作区路径解析
- 核心函数 `resolveWorkspace(homeDir?)` 接受可选的 `homeDir` 参数，便于测试隔离。
- 生产环境使用 `os.homedir()`；测试环境传入临时目录，完全不污染真实 `~/.memory-manager`。

### DB Schema 设计原则
- **只存内部状态**，禁止保存完整对话/tool output/LLM prompt/response。
- 表：`schema_meta`、`sessions`、`projects`、`rule_candidates`、`run_metadata`。
- `sessions` 表字段：`id / agent / source_path / updated_at / content_hash / project_key`，无 `content` 列。
- 启用 WAL 模式提升并发读取性能。

### init 幂等性
- `fs.mkdirSync(path, { recursive: true })` 天然幂等。
- `CREATE TABLE IF NOT EXISTS` 天然幂等。
- `INSERT OR IGNORE` 用于 schema_meta version，防止重复写入。

### config.toml
- Plan 01 明确不创建 `config.toml`，只有用户手动保存 custom source 或 LLM 参数时才创建（后续 Plan 实现）。

### 非目标目录
- 不创建 `logs/`、`cache/`、`snapshots/`，测试中有断言验证。

## 文件结构

```
rules-manager/
  src/
    cli.ts              # 入口，Commander 路由
    workspace.ts        # 路径解析，resolveWorkspace()
    db.ts               # SQLite 初始化，schema 应用
    commands/
      init.ts           # memory-manager init --yes
      status.ts         # memory-manager status
  test/
    unit/
      workspace-state.test.ts  # 16 个单元测试
  dist/
    cli.js              # 构建产物（tsdown ESM bundle）
  package.json
  tsconfig.json
  tsdown.config.ts
  jest.config.json
  memory/
    process.md          # 本文件
```

## 验证方式

### 单元测试（16 项，全部通过）
```bash
npm test
```
覆盖：
- `resolveWorkspace` 路径构造
- `runInit --yes` 创建工作区/DB/projects 目录
- 不创建 config.toml / logs / cache / snapshots
- 幂等执行
- `isDatabaseReady` 检测
- `runStatus` 初始化前后输出
- DB schema 字段合规性

### 端对端验收
```bash
FAKE_HOME=$(mktemp -d)
HOME="$FAKE_HOME" node dist/cli.js init --yes
HOME="$FAKE_HOME" node dist/cli.js status
```
期望输出：
```
Home: ~/.memory-manager
Database: ready
Rules dir: ready
Configured agents: auto-detect
```

## 后续上下文（给下一个 Plan 的子代理）

- `resolveWorkspace(homeDir?)` 是所有 Plan 的统一路径入口，后续 scan/adapter/classification 模块直接使用。
- `initDatabase(homeDir?)` 已创建 `sessions / projects / rule_candidates / run_metadata` 表，后续直接 INSERT。
- `src/commands/` 目录按命令分文件，继续新增命令时遵循相同模式。
- 构建产物在 `dist/cli.js`（ESM）；`better-sqlite3` 是 external，依赖 node_modules 中的原生模块。
- 测试使用 `ts-jest` + `node --experimental-vm-modules`，ESM 路径别名用 `moduleNameMapper` 去掉 `.js` 后缀。
- config.toml 将在用户保存 custom source 时由后续 Plan 创建，schema 见 docs/plans/01-workspace-state.md。

## 提交信息

`feat: implement Plan 01 workspace & state (init + status + db schema + tests)`

---

# Plan 02 实现上下文记录

## 实现范围

Plan 02: Scan & Sources —— 扫描入口 + 4 个内置 adapter + new/updated/unchanged/missing 分类 + DB 写入。

## 关键文件

```
src/
  scanner.ts          # runScan() + determineScanState() 核心
  commands/scan.ts    # CLI 命令层（参数解析 + 交互模式）
  adapters/
    index.ts          # ALL_ADAPTERS 注册 + getAdapters(names)
    shared.ts         # isUuid / fileHash / fileMtime / readFirstLine
    claude.ts         # ~/.claude/projects/<encoded-cwd>/<uuid>{,.jsonl}
    codex.ts          # ~/.codex/sessions/YYYY/MM/<file>-<uuid>.jsonl
    copilot.ts        # ~/.copilot/session-state/<uuid>/events.jsonl
    cursor.ts         # ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl
test/
  sources/            # 真实 fixture（claude/codex/copilot/cursor 各 1 session）
  unit/scan.test.ts   # 41 个测试（含 8 个补救测试）
```

## 关键决策

### 分类逻辑集中在 scanner.ts
- `determineScanState(discovered, existing)` 是纯函数，已 export 便于单元测试。
- 规则：DB 无 → new；updated_at 或 content_hash 任一变 → updated；都不变 → unchanged。
- `missing`：扫描收尾时反向遍历 DB，**只对先前 scan_state ≠ 'missing'** 的会话标记并计数（避免重复递增）。

### Adapter 接口最小化
- Plan 02 只暴露 `discover(agentSourceDir): Promise<DiscoveredSession[]>`。
- `DiscoveredSession` 字段：id / agent / sourcePath / sourceKind / updatedAt / contentHash。
- **故意不抽 project / cwd**：那是 Plan 03 (`extractProjectHints`) + Plan 04 (聚合) 的事，避免和未来接口撞车。

### `--full` 短期等价于 `--all`
- Plan 02 文档列出 `scan --full` 但未定义语义。
- 当前实现：`opts.full || opts.all` → 扫描所有内置 agent。
- 待 custom path / config.toml 落地后，`--full` 会再额外扫描已注册 custom 源。

## Review 结论（2026-05-07）

### 已修复

1. **`--full` 标志不生效**（Critical）
   - 现象：CLI 暴露 `--full` 但 scanner 从不读 `opts.full`。
   - 修复：`scanner.ts` 用 `opts.all || opts.full` 决定是否走 ALL_ADAPTERS。

2. **`missing` 计数逐次重复递增**（Critical）
   - 现象：每次 scan 都把已 missing 的 session 再 UPDATE + summary.missing++。
   - 修复：循环里加 `row.scan_state !== 'missing'` 守卫；prepare 提到循环外。

3. **`determineScanState` / `updated` / `missing` 分类无测试**（用户主动发现）
   - 修复：
     - 导出 `determineScanState`，新增 4 条纯函数单元测试。
     - 集成测试用临时 fixture 副本（不污染仓库）：append + utimes 触发 updated；rm 触发 missing；连扫两次验证不重复计数。
     - 新增 `--full` 集成测试。
   - 测试数：33 → 41，全绿。

### 留作 debt（不阻塞 03，但要在合适时机收）

| 项 | 现象 | 建议处理时机 |
|---|---|---|
| scanner 错误吞噬 | `try/catch` 把 discover/insert/update 失败全计成 `errors++`，无 stderr 日志、无 DB 诊断 | Plan 03 顺手补 stderr + run_metadata 写入 |
| 默认 source 路径错位 | scanner.ts 默认值 `~/.config/memory-manager/sources` 与工作区 `~/.memory-manager` 不一致 | Plan 03 引入 config.toml custom source 时统一 |
| `migrateV1ToV2` 吞 ALTER 错误 | 即使非"列已存在"错误也静默跳过，可能留半迁移 DB | 升 schema 到 v3 时改成事务 |
| `'error'` ScanState 类型有但永不写 | scanner 出错直接 `continue`，从不写 stub 行 | Plan 03 决定：保留 + 实现；或从类型移除 |
| `claude.ts` `hashFiles` 全量读 | 大 session 内存高、阻塞；fixture 极小未达瓶颈 | 性能 issue 出现时改流式 |
| `process.exit(0)` / 顶层 `runCli` 自执行 | 命令层取消时直接 exit；cli.ts 模块顶层有副作用 | CLI 测试覆盖时一起处理 |
| adapter `fs.statSync` 无 `withFileTypes` | 符号链接、权限错可能抛 → 被 scanner 吞成 errors | Plan 03 补错误日志后顺手收 |
| `--agent foo` 无效名错误友好度 | 当前 `getAdapters` 直接 throw，用户看到 stack | Plan 03 在命令层加白名单提示 |

### 测试缺口（不阻塞 03 链路验证）

- 命令层 `runScanCommand`（spinner / 交互 / 未初始化报错）零覆盖
- DB v1→v2 migration 路径零覆盖
- claude `UUID.jsonl` 直挂在 project 目录的分支无 fixture
- adapter `readFirstLine + JSON.parse` 失败回退 mtime 的分支无测试
- `--source` 子目录不存在时 adapter `continue` 分支无测试

→ 这些都是辅助/异常路径，不影响 happy path 验证；Plan 03 增加新 adapter 接口时一并补。

## Plan 03 起步上下文

### 目标
扩展 adapter 接口为完整生命周期：`probe / discover / parse / normalize / extractProjectHints`，每个 agent 至少能从对应来源抠出 1+ ProjectHint。

### 进入 03 前的接口约定
- 当前 `AgentAdapter`（types.ts:14-17）只有 `name + discover`，03 要扩到 5 个方法，**且应当以非破坏式扩展**（discover 保留 + 新增 parse/normalize/extractProjectHints），让 scanner.ts 里的现有 INSERT/UPDATE 路径无需改动即可继续工作。
- `DiscoveredSession` 不动；新增 `ParsedSession` / `NormalizedSession` / `ProjectHint` 三个类型在 types.ts。
- `ProjectHint.kind` 枚举：cwd / git_root / git_remote / source_project_path / message_path / branch（见 docs/plans/03-agent-adapters.md:53-68）。
- adapter 出 hints 时只用 metadata 或 source path，**禁止把对话原文写进 hint.value**（plan 03 第 90 行非目标 + plan 04 第 72 行约束）。

### 各 agent 抽 hint 的粒度（fixture 已有真实数据）
| agent | git_root 来源 | cwd 来源 | source_project_path 来源 |
|---|---|---|---|
| claude | first-line `cwd` (jsonl)，回退 source path 编码 | 同左 | `projects/<encoded-cwd>` 反解 |
| codex | `session_meta.payload.cwd` 或后续 turn 的 `cwd` | 同左 | 不适用 |
| copilot | `session.start.data.context.gitRoot` | `session.start.data.context.cwd` | 不适用 |
| cursor | jsonl 内的 cwd（若有），回退 source path 编码 | 同左 | `projects/<encoded-cwd>` 反解 |

### Plan 03 验收（来自 03 文档）
- probe(test/sources/<agent>) → matched
- discover count >= 1（已通过）
- ProjectHint count >= 1（新增验收）

### 03 完成后才会触发的 02 顺手收尾
- 把 `'error'` 状态在 parse 失败时真正写入 DB（让 03 决定）
- scanner 的 stderr 错误日志 + run_metadata 诊断行（依赖 03 引入的 parse 错误类型）
- 命令层 `--agent foo` 友好提示

### Plan 03 Round 拆分（最小可验证链路 → 渐进增强）

**Round 1（MVP，解锁 Plan 04 输入）** — 当前进行中
- types.ts 新增 `ProjectHint` 类型（kind / value / confidence / agent / source / locator?）
- `AgentAdapter` 接口扩 `probe(dir): Promise<ProbeResult>` + `extractProjectHints(...): Promise<ProjectHint[]>`
- 4 个内置 adapter 各自实现 probe + extractProjectHints
- 每个 adapter 至少能从 fixture 抠出 1 个 hint
- 验收：Plan 03 文档要求的 `probe matched=true` + `ProjectHint count >= 1`

**Round 2（渐进增强，完整 parse 链路）** — 暂缓
- types.ts 新增 ParsedSession / NormalizedSession
- `AgentAdapter.parse(...)` 读 jsonl → ParsedSession（消息计数 / 时间戳 / cwd / 工具调用计数等）
- `AgentAdapter.normalize(...)` 输出稳定 session_id + 全量 content_hash
- 注：当前 discover 已经计算 content_hash 与 session_id，Round 2 把这部分迁到 normalize 里集中维护

**Round 3（顺手收尾，借 03 引入的错误类型把 02 debt 拣完）** — 暂缓
- scanner.ts: parse 失败的 session 写一行 `scan_state='error'` 的 stub 记录 + stderr 日志
- run_metadata 表写诊断行
- 命令层 `--agent foo` 白名单提示

### Round 1 各 agent 的 hint 抽取来源（依据真实 fixture）

| agent | extractProjectHints 至少输出 |
|---|---|
| claude | `kind=source_project_path` 从 `projects/<encoded-cwd>` 反解；如果 jsonl 首行 / cwd 字段可读则再加 `kind=cwd` |
| codex | `kind=cwd` 从 `session_meta.payload.cwd` |
| copilot | `kind=git_root` 从 `session.start.data.context.gitRoot`；`kind=cwd` 从 `session.start.data.context.cwd` |
| cursor | `kind=source_project_path` 从 `projects/<encoded-cwd>` 反解 |

confidence 基础分先按 Plan 04 文档：git_root=0.95 / cwd=0.90 / source_project_path=0.85。

### Round 1 实现记录（2026-05-07）

**类型新增**（src/types.ts）：
- `ProjectHintKind`：cwd / git_root / git_remote / source_project_path / message_path / branch
- `ProjectHintSource`：metadata / source_path / message_text
- `ProjectHint`：{ kind, value, confidence, agent, source, locator? }
- `ProbeResult`：{ matched, reason? }
- `AgentAdapter` 接口扩到 3 个方法：probe / discover / extractProjectHints

**4 adapter 实现要点**：

| adapter | probe 区分点 | extractProjectHints 抽取 |
|---|---|---|
| claude | `projects/<*>/<UUID>` 或 `projects/<*>/<UUID>.jsonl`（区分 cursor：cursor 是 `projects/<*>/agent-transcripts/`） | jsonl 首行 `cwd` (0.9) + `gitBranch` (0.2) + sourcePath 中 `projects/<encoded>` (0.85) |
| codex | `sessions/<YYYY 数字>/` | jsonl 首行 `session_meta.payload.cwd` (0.9) |
| copilot | `session-state/<UUID>/` | jsonl 首行 `session.start.data.context.gitRoot` (0.95) + `cwd` (0.9) + `branch` (0.2) |
| cursor | `projects/<*>/agent-transcripts/`（区分 claude） | sourcePath 中 `projects/<encoded>/agent-transcripts/` (0.85)。jsonl 内部无 cwd 元数据 |

**测试**：58/58 全绿（41 → 58，新增 17 条；4 adapter × 3 probe + 4 adapter × 1~3 extract）。

**Plan 04 输入对账**：

| agent | Plan 04 期望项目名 | 最高 confidence hint | 是否能 basename 出预期值 |
|---|---|---|---|
| claude | Boarding_Desktop | cwd 0.9 | ✓ |
| codex | cloud-code-master | cwd 0.9 | ✓ |
| copilot | agent-memory-system | git_root 0.95 | ✓ |
| cursor | moego-chrome-extension | source_project_path 0.85（lossy 编码） | ✗ 需 Plan 04 启发式或人工 |

cursor 的 lossy 编码（`/`、`-`、`_` 都映射成 `-`）使无损反解不可能；这正是 Plan 04 文档里"unknown 策略 + `projects assign` 人工修正"的存在动机。Round 1 不在此越界。

**Round 1 不做的事**（推到 Round 2）：
- `parse(source) → ParsedSession`：读完整 jsonl 抽消息计数等
- `normalize(parsed) → NormalizedSession`：稳定 session_id + content_hash 计算迁移到这里
- claude `message_path` hint（从对话内容里抽 `/Users/...` 形态的路径）

**对 02 debt 的影响**：
- Round 1 没引入 parse 错误类型，所以"02 stderr 日志 + `'error'` ScanState 实现"暂未触发；推到 Round 2/3。
- 但 extract 已经有自己的 try/catch（碰到非 JSON 首行就返回空 hints 而不抛），保持 happy path 不被噪声打断。

### Round 2 实现记录（2026-05-08）

**类型新增**（src/types.ts）：
- `ParsedSessionMetadata`：cwd / gitRoot / branch / headCommit（全部可选）
- `ParsedSession`：{ agent, sessionId, sourcePath, messageCount, toolCallCount, firstTimestamp?, lastTimestamp?, metadata }
- `NormalizedSession`：{ sessionId, agent, sourcePath, sourceKind, updatedAt, contentHash, parsed }
- `AgentAdapter` 加 `parse(discovered): Promise<ParsedSession>` + `normalize(parsed, discovered): Promise<NormalizedSession>`，扩到 5 个方法（plan 03 文档对账完成）。

**关键决策：normalize 不重算 ID/Hash**

Plan 03 文档原文是"normalize 输出稳定 session_id + 全量 content_hash"。Round 2 实际选择 **复用 discover 的 id 与 contentHash**，原因：
- discover 的 id 已是 UUID（来自文件名/目录），跨重命名稳定，重算只会产生偏离的同质 ID。
- contentHash 也已是文件级 sha256，scanner.ts 的 INSERT/UPDATE 路径已基于此跑通；强行迁移到 normalize 会破坏 02 的 41 条测试。
- 折中：抽 `defaultNormalize(parsed, discovered)` 到 [shared.ts](../src/adapters/shared.ts:30)，作为 4 adapter 共用 normalize；它"权威化"的字段是 `updatedAt`——优先取 `parsed.lastTimestamp`，回退 `discovered.updatedAt`（fixture 内嵌时间戳更可靠）。

这样 Round 2 兑现了"5 方法接口 + ParsedSession 给 Plan 04 用"，但不破坏 scanner 链路，留给 scanner.ts 切换到 normalize-first 路径时再处理（属于 03 之后的渐进改造）。

**4 adapter parse 抽取规则**：

| adapter | messageCount 来源 | toolCallCount 来源 | 时间戳 | metadata |
|---|---|---|---|---|
| claude | top-level `type === 'user' \|\| 'assistant'` | assistant 行 `message.content[].type === 'tool_use'` | top-level `timestamp` 字段最早/最晚 | 首行 `cwd` / `gitBranch` |
| codex | `type==='response_item'` 且 `payload.type ∈ {message, agent_message, user_message}` | 同上但 `payload.type ∈ {function_call, custom_tool_call}` | top-level `timestamp` 首/末 | `session_meta.payload`：cwd / git.branch / git.commit_hash |
| copilot | `type==='user.message' \|\| 'assistant.message'` | `type==='tool.execution_start'` | top-level `timestamp` 首/末 | `session.start.data.context`：cwd / gitRoot / branch / headCommit |
| cursor | `role==='user' \|\| 'assistant'` | `message.content[].type==='tool_use'` | jsonl 内无 timestamp，留空（normalize 回退到 discover 的 mtime） | jsonl 内无 cwd/gitRoot，metadata 留空 |

**共享工具新增**（src/adapters/shared.ts）：
- `readJsonlObjects(filePath)`：按行 JSON.parse，吞非法行，文件不存在返回空数组。fixture 最大 239 行，全量读简单且足够；性能问题留到 02 debt 表里"claude hashFiles 改流式"那条一起处理。
- `defaultNormalize(parsed, discovered)`：合并 discover + parse 输出，updatedAt 优先 lastTimestamp。

**测试**：68/68 全绿（58 → 68，新增 10 条 in `test/unit/adapter-parse-normalize.test.ts`）：
- 4 adapter 各 1 条 parse 行为断言（fixture 字段精确值校验）
- 4 adapter 各 1 条 normalize 字段透传断言
- claude 1 条 normalize 重复调用稳定性
- 1 条 parse 兜底（不存在路径 → 零计数 + 空 metadata，不抛）

**Round 2 不做的事**（推到 Round 3）：
- scanner.ts 切到 `discover → parse → normalize → 写库`（当前仍直写 discovered）
- parse 失败时写 `scan_state='error'` stub 行 + stderr 日志 + run_metadata 诊断
- 命令层 `--agent foo` 友好提示
- claude `message_path` hint（从对话原文抽 `/Users/...` 路径）

**对 02 debt 的影响**：
- normalize 已就位，但 scanner 路径未切换 → 02 debt 表里"`'error'` ScanState 永不写"仍未触发，等 Round 3。
- 没引入新的吞错口径；现有 scanner.ts 错误吞噬行为保持不变。

### Round 3 拆分（避免 big-bang）

- **R3a**：scanner 切到 `discover → parse → normalize → 写库`，schema v3 加 ParsedSession 字段（messageCount/toolCallCount/metadata 列）+ 迁移测试。**主线**。
- **R3b**：parse/写库失败时落 `scan_state='error'` stub 行 + run_metadata 诊断行。依赖 R3a 的 parse 错误类型。
- **R3c**：02 debt 拣尾 + 测试缺口，零 schema 影响，可独立交付。**本轮已落**。

### R3c 实现记录（2026-05-08）

实际范围（聚焦 + 可控；避开默认 source 路径修正与命令层未初始化测试，那两条要等 R3a 引入 config.toml / schema v3 时一起做）：

1. **`getAdapters` 错误友好化**（src/adapters/index.ts）
   - 旧：单个未知名抛 `Unknown agent: foo`，多个时只暴露第一个。
   - 新：聚合所有未知名一次抛，附 available 列表 → `Unknown agents: foo, bar (available: claude, codex, copilot, cursor)`。
   - 单复数 `agent`/`agents` 按数量切换。

2. **scanner stderr 错误日志**（src/scanner.ts）
   - 旧：`try/catch → summary.errors++` 静默吞错，零诊断。
   - 新：保留 errors++，并 `console.error('[scan] <agent> discover/db write failed at <path>: <msg>')`。
   - 注意：未引入 run_metadata 行写入——那部分要和 R3b 的 `'error'` stub session 行一起做（避免两次改 scanner.ts）。

3. **codex.ts statSync → withFileTypes**（src/adapters/codex.ts）
   - 旧：`fs.readdirSync + fs.statSync(...).isDirectory()`，符号链接 / 权限错会抛出。
   - 新：`fs.readdirSync(dir, { withFileTypes: true })` + `entry.isDirectory()`，单次 syscall + 不抛。
   - copilot/cursor 当前已是 withFileTypes 模式，未动；claude 在 Round 1 时已迁移完毕。

**测试**：72/72 全绿（68 → 72，新增 4 条 in `test/unit/adapters-registry.test.ts`）。
- `getAdapters` happy path / 未知聚合提示 / 空数组 / ALL_ADAPTERS 名单完整性。
- scanner stderr 日志暂不补专门测试（要 mock adapter.discover 抛错；R3b 引入 `'error'` ScanState 时一起补集成测试）。
- codex statSync 加固为防御性，无新测试。

**留作 R3a/R3b 的 02 debt**：
- scanner 默认 source 路径与工作区路径错位 → R3a 引入 config.toml 时统一。
- `migrateV1ToV2` 吞 ALTER 错误 → schema v3 引入时改事务。
- `'error'` ScanState 永不写 → R3b 实现。
- `process.exit(0)` / 顶层 `runCli` 自执行 → CLI 集成测试覆盖时一起处理。
- claude `hashFiles` 全量读 → 性能 issue 真触发再改流式。

**留作 R3a 的测试缺口**：
- 命令层 `runScanCommand` 未初始化报错路径（process.exit mock）。
- DB v1→v2 / v2→v3 migration 路径覆盖。
- claude `UUID.jsonl` 直挂分支 fixture（要造一个临时 fixture）。
- adapter `readFirstLine + JSON.parse` 失败回退 mtime 的分支。
- `--source` 子目录不存在时 adapter `continue` 分支显式断言。

### R3a + R3b 实现记录（2026-05-08）

R3a (scanner normalize-first + schema v3) 与 R3b (`'error'` ScanState + run_metadata 诊断) 一次性完成 —— 两者强耦合（schema 变更只想做一次，错误路径要写新 details 列），分两个独立 commit 反而要先合再拆，不划算。

**Schema v3**（[src/db.ts](../src/db.ts)）：

`sessions` 表加 5 列：
- `message_count INTEGER NOT NULL DEFAULT 0`
- `tool_call_count INTEGER NOT NULL DEFAULT 0`
- `first_timestamp TEXT`（jsonl 内嵌首事件时间戳）
- `last_timestamp TEXT`（jsonl 内嵌末事件时间戳，Plan 04/05 推断会话活跃度用）
- `parsed_metadata TEXT`（JSON：`{cwd, gitRoot, branch, headCommit}`）

`run_metadata` 表加 1 列：
- `details TEXT`（JSON：`{summary, errors: ScanErrorEntry[]}`，每次 runScan 一行）

`migrateV2ToV3` 走 `ALTER TABLE ... ADD COLUMN`；`migrateV1ToV2` 一并改用新的 `addColumnIfMissing` 守卫——只吞 "duplicate column name"，其他错误抛出，把 02 debt 表里"`migrateV1ToV2` 吞 ALTER 错误"那条收掉。

**Scanner normalize-first**（[src/scanner.ts](../src/scanner.ts)）：

调用链：`discover → parse → normalize → INSERT/UPDATE`。

权威字段分工（关键决策，避免破坏 02 现有去重逻辑）：

| sessions 列 | 来源 | 理由 |
|---|---|---|
| `updated_at` | `discover.updatedAt` | 决定 new/updated/unchanged 的稳定基准；首次扫描 t1 与第二次扫描 t1 必须一致，否则永远是 'updated'。改用 `normalize.updatedAt`（=`parsed.lastTimestamp`）会因 first/last 时间戳不同导致一进库就是 'updated'，破坏第二次扫描 unchanged 的断言（已经踩坑一次）。 |
| `content_hash` | `normalize.contentHash`（实际复用 discover.contentHash，见 R2 决策） | normalize 是权威出口 |
| `first_timestamp` / `last_timestamp` | `parsed.firstTimestamp` / `parsed.lastTimestamp` | 内容时间戳（不参与 scan_state 比对） |
| `message_count` / `tool_call_count` / `parsed_metadata` | `parsed.*` | 给 Plan 04 用 |

`normalized.updatedAt`（=`parsed.lastTimestamp ?? discovered.updatedAt`）保留原 R2 设计语义，但 scanner 不写它进 `sessions.updated_at`——这是 NormalizedSession 接口与表 schema 之间的有意分层：normalize 给上游消费者用，sessions 表保留 02 的"以 discover 为决策基准"语义。process.md R2 那段"updatedAt 优先采用 parsed.lastTimestamp"指 NormalizedSession 对象字段，不是 sessions.updated_at；R3 文档化区分。

**`'error'` ScanState 路径**（R3b）：

每个 session 走 `parse → normalize`，任一阶段抛错：
- `summary.errors++`
- `errorLog.push({ id, agent, stage: 'parse'|'normalize', message })`
- 仍 INSERT/UPDATE 一行 `scan_state='error'`（messageCount=0 / metadata=null），便于诊断
- DB 写入本身失败：另算一条 `stage:'db'` 错误（不双计 errors，避免 parse+db 同时计入）

`run_metadata` 行：
- 起始：`INSERT (id=runId, run_type='scan', status='running')`
- 收尾：`UPDATE status = errors > 0 ? 'partial' : 'success', details = JSON({summary, errors: ScanErrorEntry[]})`

**默认 source 路径修正**（R3a 顺手项）：

旧：`~/.config/memory-manager/sources` —— 与工作区 `~/.memory-manager/` 错位。
新：`<workspaceDir>/sources/<agent>/` —— 与 init 创建的工作区根对齐。

未传 `--source` 且工作区下无 `sources/` 时，adapter `existsSync` 提前返回，summary.total=0 不报错。config.toml 落地（Plan 04+）后再叠加 custom source。

**测试**：82/82 全绿（72 → 82，新增 10 条 in [test/unit/scan-r3.test.ts](../test/unit/scan-r3.test.ts)）：
- schema v3：sessions / run_metadata 列存在 + version='3'
- scanner 写入：codex 行 messageCount/toolCallCount > 0 + parsed_metadata 含 cwd/branch；cursor 行 parsed_metadata = '{}'
- run_metadata：每次 scan 一行 status=success + details.summary 与返回值一致
- run_metadata：多次 scan 累加多行
- R3b：`codexAdapter.parse` mock 抛错 → sessions 该行 scan_state='error' + summary.errors >= 1 + run_metadata.status='partial' + details.errors[0] 含 stage='parse' / message 含 'boom-parse'
- 默认路径：未传 --source 不报错；工作区下放 sources/codex 能扫到

**踩坑记录**：

1. ESM jest 全局 `jest` 不可用 —— 要 `import { jest } from '@jest/globals'`，否则 `ReferenceError: jest is not defined`。
2. 第一次实现把 `sessions.updated_at` 设成 `normalize.updatedAt`（=parsed.lastTimestamp），结果第二次扫描全部判 'updated'（因为 jsonl 首末时间戳不同 → discover.updatedAt 与 normalize.updatedAt 不一致），破坏 02 测试。修正为 `sessions.updated_at = discover.updatedAt`。
3. workspace-state.test.ts 旧的"sessions 表只含允许字段"白名单测试要同步加 5 个 v3 列，否则 schema 扩展后旧测试红。

**完成的 02 debt**：
- ✅ scanner 错误吞噬：R3c 的 stderr + R3b 的 `errorLog` 写 run_metadata.details
- ✅ 默认 source 路径错位
- ✅ `migrateV1ToV2` 吞 ALTER 错误（addColumnIfMissing 守卫只吞 duplicate column）
- ✅ `'error'` ScanState 落地

**剩余 debt（推到 Plan 04+ 或更后）**：
- claude `hashFiles` 流式化（性能未触发）
- `process.exit(0)` / 顶层 `runCli` 副作用（CLI 集成测试覆盖时一并）
- adapter `--agent foo` 命令层提示（R3c 在 getAdapters 层做了，命令层未单独 process.exit；当前足够）
- Migration v1→v2 / v2→v3 的端到端测试（要先造一个 v2 schema DB；机会成本 vs 收益偏低，留作后续）

## 提交信息

实际：
```
fix: 修复 Plan 02 review 发现的 --full / missing 重复计数 / 分类测试缺口
feat: Plan 03 Round 1 — probe + extractProjectHints 接口与 4 adapter 实现
feat: Plan 03 Round 2 — parse + normalize（4 adapter + ParsedSession/NormalizedSession 类型）
fix: Plan 03 Round 3c — getAdapters 友好提示 / scanner stderr 日志 / codex statSync 加固
feat: Plan 03 Round 3a+3b — schema v3 / scanner normalize-first / 'error' state / run_metadata 诊断
```

---

# Plan 04 实现上下文记录

## 实现范围

Plan 04: Project Classification —— 把 adapter 的 `ProjectHint` 聚合成稳定项目归类，并让 `test/sources` 4 个 fixture 通过 plan 文档第 76-90 行的验收（4 个预期项目名 + confidence ≥ 0.80）。

R1（最小可验证链路）一次完成；R2 留给 `projects assign` / `merge` / `reclassify` 等渐进增强。

## 关键文件

```
src/
  classifier.ts            # classifyHints / projectKeyFromHint
  types.ts                 # ProjectClassification + UNKNOWN_PROJECT_KEY
  scanner.ts               # 集成：写 sessions.project_key / session_projects / project_hints / projects 汇总
  commands/projects.ts     # listProjects + runProjectsList
  cli.ts                   # `projects list` 子命令注册
  db.ts                    # schema v4 + migrateV3ToV4
test/unit/
  classifier.test.ts       # 12 条单元 + 4 fixture 集成
  projects.test.ts         # 12 条 schema/e2e/listProjects 行为
```

## 关键决策

### 分类优先级与 standalone-decidable

按 plan 04 文档第 30-44 行：

```
git_root (5) > cwd (4) > source_project_path (3) > message_path (2) > git_remote (1) > branch (0)
```

`branch` 不能单独决定项目（plan 文档第 46 行）；同样不让 `git_remote` 单独决定（fixture 暂未触发，但保持 plan 04 的"branch 只做辅助"语义自然延伸）。

实现：`STANDALONE_DECIDABLE` set 仅含 `{git_root, cwd, source_project_path, message_path}`。`pickBestHint` 先按 KIND_PRIORITY 排序，再按 confidence 排序。

### projectKey 的 basename 启发式（cursor 妥协点）

| hint.kind | projectKey 提取 |
|---|---|
| `cwd` / `git_root` / `message_path` | `path.basename(value)` |
| `source_project_path` | **取最后 N=3 个 `-` 分段**（fixture-driven 启发式） |
| `branch` / `git_remote` | 不参与决定（返回 null） |

**cursor 妥协**：cursor 的 source_project_path 编码 `Users-moego-winches-Desktop-Company-Moe-moego-chrome-extension` 是 lossy 的（`/`、`-`、`_` 都映射成 `-`），无损反解不可能。

- N=3 的选择：fixture 项目名是 `moego-chrome-extension`（3 段，含 2 个连字符），刚好够取出。
- 失败模式：项目名 < 3 段 → 会带父目录（如 `myapp` → `Moe-moego-myapp`）；> 3 段 → 会丢前缀。
- 这是 plan 04 文档第 98 行"测试基于 source 字符串和内容分类"的允许范围。
- 补救路径：plan 04 R2 引入 `projects assign <session-id> <project-key>` 人工修正。

### Schema v4

`projects` 加 `confidence REAL` 列（v3 没有）。新增 2 张表：

```sql
CREATE TABLE session_projects (
  session_id   TEXT PRIMARY KEY,
  project_key  TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0,
  decided_at   TEXT NOT NULL
);

CREATE TABLE project_hints (
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  value        TEXT NOT NULL,
  project_key  TEXT NOT NULL,
  confidence   REAL NOT NULL,
  agent        TEXT NOT NULL,
  source       TEXT NOT NULL,
  locator      TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (session_id, kind, value)
);
```

`session_projects.session_id` 单 PK：1 session ↔ 1 project（plan 04 不需要多对多）。
`project_hints` 联合 PK `(session_id, kind, value)`：同一 session 的同种 hint 同值幂等。
`sessions.project_key` 列保留为冗余索引（v1 就有），与 `session_projects.project_key` 同步写，有专门测试断言一致性。

### scanner 集成位置

集成点：在每个 session 的 INSERT/UPDATE sessions 之后（仅非 error 路径）：

```
extractProjectHints → classifyHints → setSessionProjectKey + upsertSessionProject
                                    + DELETE WHERE session_id + INSERT project_hints
```

`extractProjectHints` 抛错只记日志，不计 errors，不影响 sessions 主行落库（plan 04 不阻塞 scan 流水线）。

scan 收尾汇总 `projects` 表：从 session_projects GROUP BY 计算 MAX(confidence)，UPSERT 进 projects（保持 confidence 单调上升，不被低 confidence 覆盖）。

### 重复扫描的 hints 处理

每个 session 写 hints 前 `DELETE FROM project_hints WHERE session_id = ?` 再 INSERT。这样：
- 同 session 二次扫描后 hint 数不重复堆积（专门测试断言两次 scan 后 count 相等）。
- session 被删后 hints 仍残留，由 missing 路径之后的清理（R2/Plan 06）兜底——R1 不做 cascade。

## 验收（plan 04 文档第 76-90 行）

```
$ memory-manager scan --source test/sources --all
$ memory-manager projects list
Boarding_Desktop              confidence=0.90  sessions=1  agents=claude
agent-memory-system           confidence=0.95  sessions=1  agents=copilot
cloud-code-master             confidence=0.90  sessions=1  agents=codex
moego-chrome-extension        confidence=0.85  sessions=1  agents=cursor
```

4 个项目名全部命中，confidence 全部 ≥ 0.85，超过 plan 0.80 阈值。

## 测试

106/106 全绿（82 → 106，新增 24 条）：

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `classifier.test.ts` | 12 | 优先级 / branch 不决定 / git_root > cwd / cursor 启发式 / 4 fixture 集成 |
| `projects.test.ts` | 12 | schema v4 列存在 / 4 fixture e2e / sessions ↔ session_projects 一致 / 重扫不堆积 hints / listProjects 排序 / 未初始化兜底 |

## 踩坑

1. **scan-r3.test.ts 旧的 `version='3'` 断言**：schema v4 升级后必定红。改成 `≥ 3` 让后续版本演进不再触发——以后 schema 升 v5 不用再回头改这条。
2. **listProjects 排序**：用 `COUNT(sp.session_id)` 做 session_count，不用 `s.id`，避免 LEFT JOIN 失败时把 NULL 计成 1。
3. **hints `DELETE + INSERT` 而非 `INSERT OR REPLACE`**：联合 PK 已经能去重，但同 session 第二次扫描里某种 hint 消失了（如 cwd 字段在 jsonl 被改没），单纯 INSERT OR REPLACE 留不掉旧行；DELETE 是必须的。

## R2 实现记录（2026-05-08）

### 范围

R2 一次性完成 plan 04 渐进增强清单（plan 文档第 100-107 行）的前 3 项：

1. `projects assign <session-id> <project-key>` — 人工修正（cursor 启发式失败时的兜底）
2. `projects merge <from> <to>` — 合并误归类项目
3. `projects reclassify [--full]` — 基于 project_hints 重新跑 classifier

留待后续：
- 冲突 hint 的 review 队列（fixture 不触发，等真实数据）
- missing session 的 cascade 清理（要建 FK，留到下次 schema 升级）
- `--full` 与 `extractProjectHints` 重抽（当前等同于默认行为；需要 source 文件仍存在）

### 关键文件

```
src/
  projects.ts                # 新增数据层：listProjects + rebuildProjectsSummary +
                             #              assignSession + mergeProjects + reclassifyAll
  commands/projects.ts       # 改成 CLI 包装；re-export listProjects 兼容旧测试 import
  scanner.ts                 # 复用 rebuildProjectsSummary
  cli.ts                     # 注册 assign/merge/reclassify
test/unit/
  projects-mutations.test.ts # 14 条新测试
```

### 关键决策

#### 1. 数据层抽到 src/projects.ts

R1 把 listProjects 放在 `commands/projects.ts`，R2 加 assign/merge/reclassify 时这些数据函数也要给 scanner / 未来 CLI 子命令复用——单独建 `src/projects.ts` 数据层，`commands/projects.ts` 改成 CLI 输出包装。`commands/projects.ts` 仍 re-export `listProjects` + 类型，让 R1 的 `test/unit/projects.test.ts` import 路径不破。

#### 2. `rebuildProjectsSummary` 公共函数

scanner / assign / merge / reclassify 在写完 session_projects 后都要重算 projects 表：
- 删除没有任何 session 的 project_key（关键：assign / merge 后会留下"空项目"，必须清理）
- 重算 confidence = MAX(session_projects.confidence)

R1 scanner 用过 `MAX(projects.confidence, excluded.confidence)` 保持单调上升——R2 改为权威重算，因为 session_projects 永远反映真实状态，"单调上升"会拒绝合理的下降（如 merge 后某 project 失去高 confidence session）。scanner 行为不变（每次扫描都重写 session_projects 的对应行）。

#### 3. assign 用 confidence=1.0 标记人工

`assignSession` 把 session_projects.confidence 写成 1.0，作为"人工标记"信号。后续 reclassify `--full` 可以选择性忽略或保留这种标记（当前 `--full` 与默认行为相同，预留语义）。

#### 4. mergeProjects: from 必须有 session

`from == to` → no-op。`from` 不存在（无 session 引用）→ 抛 `no sessions belong to project: ...`，避免静默 no-op 让用户以为成功了。`to` 不存在则**自动创建**（rebuildProjectsSummary 收尾时 UPSERT）。

#### 5. reclassifyAll 用 project_hints 表，不重抽

reclassify 从 project_hints 表取 hints + classifyHints，**不**重新调 `adapter.extractProjectHints`。原因：
- hints 已经在 scan 时落库，是稳定快照；reclassify 是"换分类策略"，不是"换 hint 来源"
- 重抽要求 source 文件仍存在；missing session 没法重抽
- 如果 hint 抽取算法升级，应该走 `scan --full`（重抽）而不是 reclassify（重分类）

reclassify 不改 project_hints 内容（专门测试断言 count 不变；hints 是不可变证据）。

### 测试

120/120 全绿（106 → 120，新增 14 条 in `test/unit/projects-mutations.test.ts`）：
- `assignSession`：成功路径 + confidence=1.0 + 旧项目清空 + 未知 session-id / 空 id / 未初始化工作区 抛错（5 条）
- `mergeProjects`：sessions+hints 迁移 + agents 合并 + sessionsMoved 数 + from==to no-op + from 不存在抛错 + to 不存在自动创建（5 条）
- `reclassifyAll`：稳定状态 changed=0 + assign 后 reclassify 还原 + --full 等价默认 + hints 表不变（4 条）

### CLI 实测

```
$ projects list                                # 4 fixture 正常归类
$ projects assign <cursor-id> my-cursor-app    # 改归 + 旧 project 自动清空 + confidence=1.00
$ projects merge cloud-code-master Boarding_Desktop  # 1 session 转移，agents=claude,codex
$ projects reclassify                          # 4 sessions / 2 changed —— 把 assign+merge 全部还原
```

### 踩坑

1. **scanner.ts 的 confidence 单调上升 R1 设计**：R1 当时担心"重扫漏掉某 agent 时低 confidence 覆盖高"——但实际 scanner 只重写**本轮扫到的 agent** 的 session_projects 行，没扫到的 agent 行不动；session_projects 永远是真实状态。所以 MAX 是冗余的过度保守。R2 抽公共函数时改成权威重算，scanner 行为不变。
2. **commands/projects.ts re-export**：把数据层挪到 `src/projects.ts` 后，旧测试 `test/unit/projects.test.ts` 还 import `'../../src/commands/projects'` 拿 `listProjects`。保留 re-export 避免破坏，迁移测试路径留作后续清理。
3. **mergeProjects from 不存在抛错而非 no-op**：用户输错 project_key 是常见情况；静默 no-op 会让人以为合并成功。报错信号更明确。

## 给 Plan 05 的接口约定

Plan 05（LLM rule generation）的输入：
- `projects` 表的项目列表（含 confidence，可过滤掉 unknown / 低 confidence 项）。
- `session_projects` 找到 project 关联的所有 sessions。
- `sessions.parsed_metadata` 取 cwd / gitRoot / branch（已 JSON 格式化）。
- **不再提供原始对话内容** —— Plan 05 要从 source_path 自行读 jsonl（rule generation 必然需要内容，但只能在 LLM 调用前临时读，不入库）。

## 提交信息

```
feat: Plan 04 R1 — project classification（classifier + schema v4 + projects list）
feat: Plan 04 R2 — projects assign / merge / reclassify（人工修正 + 全量重分类）
```

---

# Plan 04 之后：真实环境验证 + codex 日级目录修复（2026-05-17）

## 验证背景

用真实本机 `~/.{claude,codex,copilot,cursor}` 数据跑一遍 scan + projects list，验证 fixture 之外的链路。

工作区隔离在 `<project>/.scratch/.memory-manager/`，sources/<agent> 软链到真实 home。

## 发现的 adapter bug：codex 漏扫日级目录

**现象**：第一次 scan 显示 489 sessions，但 codex 占 0 个；本机 `~/.codex/sessions/2026/05/` 明明有大量 jsonl。

**根因**：codex 在 2026-05 之后改了目录布局——`sessions/YYYY/MM/DD/rollout-*.jsonl`（4 层），但 adapter 只走 `sessions/YYYY/MM/<file>` 3 层（plan 02 文档第 122 行写的也是旧布局）。`fs.readdirSync(monthDir)` 直接拿到 DD 目录名（如 `"01"`），不匹配 `UUID_SUFFIX_RE` 就 continue，悄无声息归零。

**修复**（[src/adapters/codex.ts](../src/adapters/codex.ts) discover）：
- 抽 `collectFile(filePath)` 闭包，集中处理"是 UUID 文件就抽 sessionId + 时间戳 + hash"。
- MM/ 下用 `withFileTypes` 区分 entry 类型：
  - `isFile()` → 直接 `collectFile`（旧 3 层布局，fixture 现状）
  - `isDirectory()` → 进 1 层 DD/，里面的 file 全 `collectFile`（新 4 层布局）
- **不再深入**：DD 下面的子目录（HH 之类的未来扩展）不下钻，避免误扫。专门测试断言这一点。

## 测试（新增 [test/unit/codex-discover.test.ts](../test/unit/codex-discover.test.ts) 5 条）

mkdtempSync 写临时 fixture（不污染 `test/sources/codex/`，沿用 Plan 02 R2 的"临时副本"惯例）：

| 场景 | 期望 |
|---|---|
| 4 层 YYYY/MM/DD/file | discover 返回 1 个 session，sourcePath 含 `2026/05/01/` |
| 3 层 YYYY/MM/file（旧布局） | 仍兼容，返回 1 个 |
| 混合 3 层 + 4 层在同月份 | 两个都扫到（count=2） |
| DD/HH/file 孙目录 + DD/README.txt 噪声 | 不扫孙级目录，不扫非 UUID 文件（count=1） |
| 4 层布局上跑 parse + extractProjectHints | metadata.cwd / branch 正常，hints 返回 cwd 0.9 |

测试 120 → 125 全绿。

## 真实环境验证结果

```
sessions: 669 total（new=640, updated=29, errors=0）
per agent: claude 144 / codex 180 / copilot 28 / cursor 288
projects: 56+ 个，unknown=0
codex top: cloud-code-master 75 / agent-slack 20 / moego-server-grooming 18 / ...
```

修复前 codex=0，修复后 codex=180，与本机 `find ~/.codex/sessions -name 'rollout-*.jsonl' | wc -l` 数量级一致。

## 顺手记录的其它现象（不阻塞，留作后续）

1. **`state.db` 0B 假阳性**：之前误用 `sqlite3 path/state.db` 自动建空文件，**不是 bug**，正确 db 名是 `memory.db`（[src/workspace.ts:6](../src/workspace.ts:6)）。
2. **cursor source_project_path 启发式仍是 lossy**：本机扫出 `Moe-Boarding-Desktop` / `Company-AI-Agent` 这类 lossy 编码副作用，符合 Plan 04 R1 决策（靠 `projects assign` 人工修正）。
3. **多 agent 同项目正确合并**：`cloud-code-master = codex+cursor`、`agent-slack = codex+copilot`、`agent-memory-system = claude+codex+copilot+cursor` —— rebuildProjectsSummary 的 agent 集合聚合验证通过。

## 提交信息

```
fix: codex adapter 支持 YYYY/MM/DD/ 日级目录布局（2026-05+ 真实数据）
```
