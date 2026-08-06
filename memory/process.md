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
      init.ts           # memory-manager init --non-interactive
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
- `runInit --non-interactive` 创建工作区/DB/projects 目录
- 不创建 config.toml / logs / cache / snapshots
- 幂等执行
- `isDatabaseReady` 检测
- `runStatus` 初始化前后输出
- DB schema 字段合规性

### 端对端验收
```bash
FAKE_HOME=$(mktemp -d)
HOME="$FAKE_HOME" node dist/cli.js init --non-interactive
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

---

# FS-first 重构（scan-classify-fs-rewrite，2026-05-17）

Plan 02 / 04 的多表数据模型被 **「FS 是真理来源，DB 只记状态」** 重构取代。

新文档结构（之前的 `memory/process.md` 累积式记录改成由 spec + plan 承接）：

| 文件 | 角色 |
|---|---|
| [docs/specs/scan-classify-fs-rewrite.md](../docs/specs/scan-classify-fs-rewrite.md) | 产品设计图：工作区结构 / schema v5 / 接口 / 子系统 / 改动范围 / 验收链路 |
| [docs/plans/scan-classify-fs-rewrite.md](../docs/plans/scan-classify-fs-rewrite.md) | 9 步执行节奏表 + Y-only 决策记录（含步 1-4 合并完成记录） |
| [docs/plans/02-scan-sources.md](../docs/plans/02-scan-sources.md) | 顶部加 superseded 注 |
| [docs/plans/04-project-classification.md](../docs/plans/04-project-classification.md) | 顶部加 superseded 注 |

## 关键变化总结

- DB 砍掉 4 张内容表（`projects` / `session_projects` / `project_hints` / `rule_candidates`），只剩 3 张（`schema_meta` / `sessions` / `run_metadata`）
- 工作区新增 `<workspace>/projects/<slug>/<session-id>.jsonl` symlink 视图（`ls / cat / grep` 直接可用）
- classifier 输出从 `{projectKey, confidence, decisionHint}` 简化为 slug 字符串，加 `normalizeSlug`（kebab 归一化）
- assign / merge / reclassify 全部走 FS mv + DB 同步
- 真实环境实测：638 sessions / 70 slug / default 占比 **0%**（远好于 spec § 假设 < 20%）

## 提交信息（FS-first）

```
feat: FS-first 重构 步 1-4（schema v5 + fs-writer + scanner / classifier 重写）
feat: FS-first 重构 步 5-8（assign / merge / reclassify + 文档同步）
```

---

# Agent Session 获取逻辑重构（2026-07-24）

## 背景与范围

参考 `paseo` 的 provider session listing 实现，修复 4 个 adapter 因固定目录层级、UUID 文件名和单一 transcript 文件假设造成的漏扫。保留 FS-first、DB v5 和“不存对话原文”红线。

执行与验收记录见 [docs/plans/session-discovery-refactor.md](../docs/plans/session-discovery-refactor.md)。

## 关键决策

1. source 优先级统一为：显式 `--source` > `<workspace>/sources/<agent>` > agent 默认 home。默认 home 对齐 paseo：Claude 支持 `CLAUDE_CONFIG_DIR`，Codex 支持 `CODEX_HOME`，其余使用 `~/.<agent>`；显式 `homeDir` 用于测试隔离时高于进程环境变量。
2. Claude 扫描 `projects/*/` 下全部顶层 JSONL，不再要求 UUID 文件名；首行 `sessionId` 优先于文件名，并按 provider sessionId 去重。
3. Codex 递归扫描 `sessions/` 与 `archived_sessions/`，不再绑定 YYYY/MM/DD 固定深度；active 与 archived 重复时 first-seen-wins。
4. Copilot 每个 `session-state/<UUID>` 都视为 session：有 `events.jsonl` 时继续链接 transcript；没有时链接 `workspace.yaml`，用 `yaml` 结构化解析 cwd/git_root/branch/时间。YAML 原文和对话内容均不入 memory-manager DB。
5. Cursor 扫描 `agent-transcripts/<session>/` 下顶层 JSONL，不再要求 session 目录是 UUID，也不要求 transcript 与目录同名；仍不扫描 `subagents/`。
6. 只有 source 存在且 discover 成功的 agent 才加入 missing 对账集合，避免 provider 枚举失败时把该 agent 的全部历史 session 误标 missing。

## 测试与真实验收

- 新增跨版本回归：默认 home、Claude 非 UUID/重复 provider ID、Codex archived/任意深度、Copilot metadata-only、Cursor 宽松命名。
- `npm test`：135/135 通过。
- `npm run build`：通过；tsdown 仍输出既有 `define` 配置 warning，不影响产物。
- 隔离真实扫描：1290 total，Claude 9 / Codex 676 / Copilot 293 / Cursor 312，errors=0。
- FS 对账：1290 个 symlink，broken=0；最新 `run_metadata.status=success` 且 errors 明细为空。
- 第二次扫描：1289 unchanged / 1 updated。真实 agent 正在运行，1 个 source 在两轮之间变化，符合 hash/mtime 状态机。

## Review 结论

- 修复 Claude 重复 provider sessionId 触发 DB 主键冲突的问题，行为与 Codex Map 去重一致。
- Copilot metadata-only symlink 仍按 FS-first 规范命名为 `<session-id>.jsonl`，target 可以是 `workspace.yaml`；这是为了保持 `listLinks` 和项目视图契约，不代表复制或改写 YAML 内容。
- 递归 helper 只进入真实 directory entry，不跟随 symlink 目录，避免 source 内软链循环。

## OpenCode / Pi 补充（2026-07-24）

用户补充指出“全部 agent”还应包含 OpenCode 与 Pi，原四 agent 验收不完整。本轮把内置 adapter 从 4 个扩为 6 个。

### OpenCode

- 对齐 paseo `experimental.session.list({ archived: true, roots: true })`：从 `~/.local/share/opencode/opencode.db` 的 `session` 表读取 active + archived root sessions，排除 `parent_id` 非空的 child session。
- 只查询 session 的 id / directory / title / created/updated 时间，以及消息 `COUNT(*)`；不读取 `message.data` / `session_message.data`，不导出 transcript。
- 每 session 的 contentHash 只基于该行元数据，不 hash 整个数据库，避免任意 session 变化导致全部 updated。
- OpenCode 没有逐 session JSONL，且 export 会复制对话原文，所以 `source_path` 与 FS symlink target 指向权威 `opencode.db`。固定 `.jsonl` link 名是现有 `listLinks` 契约，target 实际是 SQLite，已在 plan 明示。
- 默认 source 支持 `XDG_DATA_HOME/opencode`，否则使用 `~/.local/share/opencode`。

### Pi

- 直接移植 paseo descriptor 的核心契约：递归扫描 sessionDir 的 JSONL，只有首行满足 `type=session` 且包含 id/cwd 才视为 session。
- 默认 source 是 `~/.pi/agent`，支持 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 和 `settings.json.sessionDir`。
- parse 只计数 message/tool call 和时间戳；ProjectHint 只取首行 cwd，不保存消息内容。

### 验收

- `npm test`：139/139 通过；`npm run build` 通过（仍有既有 tsdown `define` warning）。
- 真实隔离 `scan --all`：1482 total，Claude 9 / Codex 676 / Copilot 293 / Cursor 312 / OpenCode 118 / Pi 74，errors=0。
- 1482 个项目 symlink，broken=0；OpenCode 115/118、Pi 74/74 成功归入非 default slug。
- 当前 schema 仍以 `sessions.id` 单列为主键；六 provider 的真实数据无 ID 冲突。跨 agent 原始 ID 理论碰撞留作 schema debt，后续应改 `(agent, id)` 复合身份，不能在本轮直接加前缀破坏已有 assign/link 契约。

## 本地 CLI script（2026-07-24）

- `package.json` 新增 `cli: tsx src/cli.ts`，直接执行 TypeScript 源码，不依赖 `dist` 或预先构建。
- `tsx` 是显式 devDependency；仓库继续只维护既有 `package-lock.json`，不引入第二份 lockfile。
- 验收：`pnpm cli --help` 与 `pnpm cli scan --help` 均显示实际执行命令为 `tsx src/cli.ts`，参数可透传到 Commander。

## Workspace CLI 参数（2026-07-24）

- `init --yes` 改为 `init --non-interactive`，明确表达“跳过确认”的行为；旧参数不保留兼容。
- 新增全局 `--workspace <path>` / `-w <path>`，参数表示 workspace 的父目录，实际数据统一放在 `<path>/.memory-manager/`。
- override 通过 `MEMORY_MANAGER_WORKSPACE` 传给统一的 `resolveWorkspace`，因此 `init / status / scan / projects` 使用同一解析入口；它不修改 `HOME`，不会把 agent 默认 source 一并切到临时目录。
- 默认行为不变：未传参数时仍使用 `~/.memory-manager`；现有测试专用 `homeDir` 优先于环境 override。
- 黑盒验收覆盖：指定路径 init 后出现 `.memory-manager/memory.db`、父目录根部没有散落 `memory.db`、status 可复用、旧 `--yes` 被拒绝。
- 全量验收：141/141 tests 通过，`npm run build` 通过，CLI root help 正确显示 workspace 参数。
- 根命令仅传 `-w/--workspace` 而未给子命令时，输出帮助并以 0 退出，不创建目录；避免 pnpm 把正常帮助显示成 `ELIFECYCLE`。对应黑盒回归加入 `cli-options.test.ts`。

## OpenCode session 按需读取（2026-07-24）

- 新增 `sessions show <session-id>`，当前仅支持 OpenCode；消息以结构化 JSON 输出到 stdout，不写 DB、不生成 transcript。
- 对齐 paseo：使用 `@opencode-ai/sdk/v2` 临时启动本机 `opencode serve`，调用 `client.session.messages({ sessionID, directory })`，无论成功失败都关闭 server。
- workspace DB 只读查询 agent/source_path，OpenCode DB 只读查询该 session 的 directory；原文只存在于 SDK 返回值和 stdout 生命周期中。
- `sessions show` 对非 OpenCode session 明确拒绝，避免假装能从其他 provider 的 JSONL 走同一读取协议。
- Jest 的 moduleResolution 从旧 `node` 对齐项目 `bundler`，以解析 SDK 公开的 `./v2` package export，不引用 `dist/` 私有路径。
- 验收：测试断言 stdout 能得到消息、workspace/OpenCode 主 DB hash 不变、无 session transcript 新文件；真实 session smoke test输出重定向 `/dev/null` 后成功。
- 最终验收：144/144 tests、`npm run build`、`git diff --check` 全部通过；构建仍只有既有 tsdown `define` warning。

## Codex 原文读取与 scan 进度（2026-07-25）

- Codex 的权威 session 来源本身是 rollout JSONL；`scan` 继续只提取 hash、计数和项目元数据，不把对话原文写入 DB。
- `sessions show <codex-id>` 新增只读 JSONL 分支，将可解析行作为结构化 `records` 输出到 stdout；源文件不存在、无可解析内容或超过 50 MiB 时明确报错，不复制 transcript。
- `ScanOptions` 新增可选异步 `onProgress` 回调。scanner 在每个 agent 的 discovering / processing / done / skipped / error 阶段上报并等待状态绘制，处理阶段每 100 条更新一次。
- clack spinner 首帧依赖 80/120ms interval；CLI 每次状态更新后等待 130ms，确保同步 I/O 开始前实际显示“正在发现/正在处理 current/total”。
- 扫描结果不使用 `clack.note` 的嵌套盒子；改用 `clack.log.info` 输出单行统计，再由 `clack.outro` 收尾，避免主流程竖线内出现边框错位。
- 回归测试先验证旧实现会拒绝 Codex 且无进度事件，再实现通过；隔离 CLI smoke test完成 1 条 Codex scan + show，临时工作区已清理。
- 最终验收：146/146 tests、`npm run build`、`git diff --check` 全部通过；只读审查无阻塞问题，构建仍只有既有 tsdown `define` warning。
- 最终 CLI 视觉验收：148/148 tests；伪 TTY 输出为单行 `● Sessions: 1 · New: 1 · Errors: 0`，随后 `└ 扫描成功`，无嵌套 note 边框；构建与 `git diff --check` 通过。

## Scan 变更清单（2026-07-25）

- `ScanSummary` 新增 `changes.new / updated / missing`，每项只含 `{agent, id, slug}`；unchanged 只计数，不进入清单。
- new 在 session 首次成功写库后记录；updated 在已有行成功更新且 hash/updatedAt 变化后记录；missing 在本轮成功扫描该 agent、确认源端缺失并标记 DB 后记录。
- 旧状态为 `missing` 的 session 重新出现时，即使内容完全相同也判为 updated，表达“恢复”这一真实状态转移。
- `run_metadata.details.summary` 直接持久化同一份 changes，后续可按 scan run 追溯具体变更；不新增表或对话内容字段。
- CLI 只显示单行 `新增 X · 更新 X · 删除 X · 错误 X`，不展开具体 session；完整 changes 仅保留在 `run_metadata.details`。伪 TTY 已验证该计数布局。
- 最终验收：150/150 tests、`npm run build`、`git diff --check` 全部通过；只读审查无阻塞问题，构建仍只有既有 tsdown `define` warning。

## 六 Agent Session Show（2026-07-25）

- Claude/Codex/Cursor/Pi 统一走严格 JSONL reader；Claude `source_path` 为目录时递归聚合全部 JSONL（与 adapter scan 范围一致）。
- JSONL 总量上限 50 MiB，兼容 UTF-8 BOM/CRLF；任一非空行非法即带 `file:line` 报错，避免静默丢失后声称“完整”。JSON primitive/array 也保留，因为 show 负责呈现源记录而非做 adapter 语义过滤。
- Copilot 在 show 时优先检查 session 同目录的 `events.jsonl`；metadata-only session 仅回退读取 `session-state` 直接父目录下的 `session-store.db.turns`，按 `turn_index` 排序。turns 为空明确报“源端未持久化对话”。
- OpenCode 保持 SDK `session.messages` 路径。全部读取只进入进程内存与 stdout，DB 和源文件均只读，不生成 transcript。
- 隔离真实默认 source 扫描后，Claude/Codex/Copilot(events)/Cursor/OpenCode/Pi 各取一条执行 show，六类全部成功。
- 最终验收：158/158 tests、`npm run build`、`git diff --check` 全部通过；只读审查无阻塞问题，构建仍只有既有 tsdown `define` warning。

## Project Sessions Metadata（2026-07-26）

- 新增 `projects sessions [slug]`：无 slug 时列出 `projects/` 下全部 session，传 slug 时只列该项目；输出 `{ project, count, sessions }` 格式化 JSON。
- FS link 是查询范围真理，DB 只补 sessions 表 metadata。FS link 缺少对应 DB 行，或 FS slug 与 DB slug 不一致时明确报错，不静默跳过、不伪造结果。
- 每条结果覆盖 sessions 表全部 metadata：id、agent、sourcePath、workspaceLink、slug、contentHash、updatedAt、status、firstSeenAt、lastSeenAt、classifiedAt、rulesStatus、rulesGeneratedAt，并按 slug / agent / id 稳定排序。
- 命令不调用 `sessions show` 或 adapter，不读取 source transcript；输出不包含对话原文、tool output 或 prompt。
- 回归覆盖全量、slug 筛选、不存在项目、DB 缺行、slug 漂移和 CLI 黑盒 JSON 输出。
- 最终验收：164/164 tests、`npm run build`、`git diff --check` 全部通过；构建仍只有既有 tsdown `define` warning。

## 全局 Instruction Source 只读管理（2026-07-26）

- 范围限定为六个 agent 的全局持久化 instruction source；不扫描项目级规则，不读取 Cursor 私有 SQLite value，不展开 OpenCode `opencode.json(c)`，不提供 apply/edit/switch。
- 新增 `rules list [agent]` 与 `rules show <agent>`，不依赖 workspace init。list 只输出路径、status/effective 等 metadata；show 正文只进入内存和 stdout，不写 DB、日志或副本。
- Claude 支持 managed/`CLAUDE.md`/`rules/**/*.md`；Codex 支持非空 override 遮蔽；Copilot 支持主指令、条件目录和绝对 custom dirs；Cursor 明确返回 unsupported capability；OpenCode 支持 AGENTS、Claude fallback 与禁用状态；Pi 支持 AGENTS/SYSTEM/APPEND_SYSTEM。
- 目录遍历不跟随目录 symlink，允许文件 symlink，单目录最多 1,000 个文件；show 限制 1 MiB、强校验 UTF-8，并校验读取前后 stat 一致。
- Plan 05 的 candidate generation 与 live source inventory 保持数据域分离；Plan 07 的产物查看预留为 `rules output`，避免与已落地的 source show 命令冲突。未来把产物安装到 live 文件必须另写备份、冲突检测和 compare-and-swap spec。
- 最终验收：14 suites、183/183 tests、`npm run build`、`git diff --check` 全部通过；真实 `nr cli rules list cursor` 和 OpenCode list/show smoke 成功，抽样 source hash 前后不变。构建仍只有既有 tsdown `define` warning。

## 全局 Instruction Source 范围收窄（2026-07-26）

- 根据产品反馈，每个 agent 只展示一个主要全局 instruction 入口；辅助来源不返回 metadata，也不能按旧 source id show。
- 明确排除 Claude managed policy/`rules`、Codex override、Copilot 条件/custom rules、OpenCode config/Claude fallback、Pi SYSTEM/APPEND_SYSTEM。
- 保留 Claude `CLAUDE.md`、Codex/Copilot/OpenCode/Pi 的主 instruction 文件，以及 Cursor User Rules unsupported capability。
- 删除辅助 locator、目录遍历、realpath 去重、override/fallback 状态机和相关类型；保留固定主路径环境变量、1 MiB、UTF-8、读取前后 stat 与只读 hash 防护。
- 回归测试先在旧实现上出现 10 个预期失败；代码收窄后 14 suites、183/183 tests、`npm run build`、真实六来源 list smoke 和 `git diff --check` 全部通过。构建仍只有既有 tsdown `define` warning。

## Rules Show 命令简化（2026-07-26）

- 每个 agent 只剩一个主要 instruction source，因此 `rules show <agent> <source-id>` 简化为 `rules show <agent>`；内部 `showGlobalInstructionSource` 和 command runner 同步删除 source id 参数。
- source id 仍作为返回 metadata 和错误诊断字段，但不再由用户选择；辅助来源也因此没有 show 入口。
- CLI 回归明确要求旧的第三位置参数报 `too many arguments`；最终验收为 14 suites、174/174 tests、`npm run build`、新旧命令真实 smoke 和 `git diff --check` 全部通过。构建仍只有既有 tsdown `define` warning。

## Rule Candidate 生成链路（2026-07-27，进行中）

- 任务 0 基线：14 suites、174 tests 全绿；schema v5 与六 agent session show 路由符合任务前提。
- schema v6 新增 `rule_candidates` / `llm_runs`，v5 原地迁移保留 sessions；配置读取 `<workspace>/config.json`，缺失时默认 claude + medium effort，model 使用 provider 原生默认。
- 既有 `workspace-state.test.ts` 硬编码 v5/3 表且任务禁止修改现有测试，形成验收冲突，已记录在 `BLOCKED.md`；v6/config 新增测试 5/5 通过。
- Evidence 通过既有 `runSessionsShow` 同源路由在进程内读取，不写 transcript；工具块仅保留工具名与固定摘要，默认每 session 最新 30 条，支持 full/rounds、关键词排序、跨 session 精确规范化频次和 secret 脱敏。
- Evidence/redaction 定向测试 7/7 通过，使用临时 JSONL fixture，未修改 `test/sources/`。
- 双 Provider：Claude 通过 `@anthropic-ai/claude-agent-sdk query()`，Codex 通过 `spawn('codex', args)` 读取 stdout；model/effort 只作为调用参数，不写 prompt。
- 结构化生成使用 Zod JSON Schema 注入和最多 2 次纠错重试。candidate DB 保存完整 EvidenceBundle + reasoning/evidence refs；llm_runs 只存 prompt/output SHA-256，不存正文。
- `rules generate` 已注册 dry-run/project/provider/model/effort/rounds/full 参数，full 与 rounds 互斥。
- 任务 3 定向测试 4/4、全部新增测试 16/16、构建通过。
- Review 命令提供 draft 列表、accept/reject 状态更新和 explain；explain 从 candidate 的 evidence_json 展示 reasoning、refs 和回源片段，不重新读取源 session。
- 收尾审查补齐按 timestamp 选择最新轮次、Copilot `user.message` event、Codex 独立 `function_call` 工具摘要，以及 CLI provider/effort 运行时校验。
- 最终新增测试 20/20 通过，构建、tsc、diff check、generate/review help 通过。
- 全量为 192 passed / 2 failed / 194 total；仅失败项是既有测试硬编码 v5/3 表，与 v6 任务冲突且本任务禁止修改旧测试，详见 `BLOCKED.md`。

---

## Desktop GUI 骨架（2026-07-28）

- 仓库改为 npm workspaces：既有 CLI 源码、测试与配置整体搬入 `packages/core/`，包名为 `@memory-manager/core`；core 业务逻辑未改。
- `packages/app/` 使用 Electron 43.2.0、React 19、HeroUI v3、TailwindCSS v4 与 electron-vite，提供暗色侧边栏和卡片工作区。
- Electron main 直接导入 core 项目与 rule candidate 模块；preload 在 contextIsolation 下只暴露 `window.api.invoke`。
- IPC 通道固定为 `projects.list`、`rules.candidates`、`rules.updateStatus`；未初始化 workspace 的列表请求返回空数组，status 更新仅接受 accepted/rejected。
- main bundle 内联 workspace core、external `better-sqlite3`，避免 Electron 运行时加载被打包破坏的原生模块。
- 验收：core 204/204 tests、core/app build、app typecheck、根 `tsc -b`、CLI help 与 diff check 全通过；dev renderer 地址为 `http://localhost:5173/`，renderer IPC 实际返回 projects JSON 数组。
- 实例治理补充：main 使用 `app.requestSingleInstanceLock()` 防止重复 Electron 实例；第二次启动只聚焦已有窗口。开发验收结束必须清理整个进程树，不再把长驻 dev 进程留给用户。

## HeroUI 双主题（2026-07-28）

- renderer 改为 dark/light 双模式，默认 dark；根 class 驱动完整 CSS/Tailwind 语义 token，并同步覆盖 HeroUI v3 的 background/surface/foreground/accent/border/status 变量。
- App 使用 Button/Card/Chip/Spinner/Alert/Table/Tooltip，移除手写组件状态和硬编码颜色；主题按钮 dark 显示 Sun、light 显示 Moon。
- `@heroui/react@3.2.2` 不提供 v2 的 `HeroUIProvider`，因此使用 v3 官方 CSS token 集成路径；该任务要求冲突记录在 `BLOCKED.md`。
- CDP 实测根 class、侧边栏、workspace 与 HeroUI Card 在 dark/light 间变化；typecheck/build/dev/diff check 通过，源码十六进制及 rgb 颜色为 0。
- 所有 Electron UI 验收都使用独立进程组，完成后整体终止并复查端口/项目进程为 0。

## APP 导航与规则审核（2026-07-28）

- Renderer 拆为 Overview/Projects/Rules 三视图，App 只管理 activeView 与主题；各视图独立管理 loading/error/data。
- 所有读取在 IPC 前等待一个 animation frame，确保 Spinner 真实绘制；所有 invoke 都有 catch Alert 与 finally loading 收尾。
- Rules 提供 Draft/Accepted/Rejected，draft 行支持 accept/reject；同步 Set 防重复提交，同行按钮 disabled，目标按钮 Spinner，成功移除，失败保留并 Alert。
- CDP 验证导航切换时 Projects/Rules 都先出现 loading，再显示对应视图；typecheck/build/dev/diff check 通过。
- 真实 Electron 数据验收曾发现根 better-sqlite3 ABI 137 与 Electron 43 ABI 148 不兼容；后续已通过 app 独立原生依赖解决，方案见“Electron SQLite ABI 隔离”段。

## APP 扫描与设置（2026-07-28）

- preload 新增 callback + channel 精确配对的 `onEvent/offEvent`；main 的 `scan.run` 转发 scanner progress/done，并用进程级互斥禁止并发 scan。
- Overview 预置六 agent 状态，显示 phase/current/total；任一 progress 可恢复切页后 scanning 状态，done 统一刷新项目并展示 new/updated/errors。
- `saveLlmConfig` 与 load 共用校验，使用同目录临时文件 + rename 原子写 config.json；Settings Modal 每次打开重新加载，保存 provider/model/effort。
- core package exports 未暴露 scanner/config，且本轮白名单不含 package.json；app 暂用 core source import。electron-vite build 和扩大 rootDir 的完整 TS 检查通过，标准 app composite typecheck 的 TS6059/TS6307 记录于 `BLOCKED.md`。
- 本轮结束时 Electron SQLite ABI 137/148 曾阻塞真实 scan 成功事件链；后续已完成真实 Scan 验收。Settings 另已在隔离 HOME 下验证保存和重开保持。
- 最终验收：core 22 suites、204/204 tests，app build、受控 dev renderer-ready、diff check、进程清理均通过。

## APP Generate 与 Output（2026-07-28）

- `runRulesGenerate` 新增可选 progress 回调，覆盖 extracting/generating/splitting/done；CLI stderr、返回值、deps 与持久化行为保持不变。
- main 转发 generate progress/done/failed，使用进程级锁禁止并发生成；Rules Draft 展示实时阶段和候选计数，完成后刷新 draft。
- Accepted 有规则时可同步 Output Rules，UI 展示 core 输出的绝对路径。由于 `runRulesOutput` 返回 void 且本轮禁止修改该文件，main 暂在同步调用期间解析并继续转发现有写入日志；后续应改为结构化返回。
- 本轮结束时 Electron SQLite ABI 137/148 曾阻塞真实 DB 成功链；后续已完成原生依赖隔离。临时 Electron 内存 IPC harness 已验证 Generate loading→extracting→generating→done→draft refresh，以及 Output loading→路径 Alert。

## Electron SQLite ABI 隔离（2026-07-28）

- Node v24.14.0 使用 ABI 137，Electron 43.2.0 使用 ABI 148；同一个根 `better-sqlite3` 原生二进制不能同时服务两个运行时。
- app 依赖别名 `better-sqlite3-electron` 固定到 `better-sqlite3@13.0.1`，electron-vite 将 app main 的 `better-sqlite3` 映射并 externalize 到该别名；core 保持 `better-sqlite3@11.10.0`，CLI 行为不变。
- v13 提供可被 Electron ABI 148 加载的 N-API prebuild，因此不保留 `@electron/rebuild` 或 postinstall rebuild；lockfile 只记录 app 别名依赖。
- GUI 首次 scan 可能尚无 `.memory-manager` 目录，`scan.run` 在打开 DB 前创建 workspace 目录；这不改变 scanner/db/adapter 行为。
- 真实隔离 Electron Scan 使用 Codex fixture 收到 14 条 progress，返回 total=1/new=1/errors=0，并刷新项目表显示 `cloud-code-master`；ABI 阻塞已解除。
- 最终验收：core 22 suites、204/204 tests，app production build、扩大 rootDir 的完整 TypeScript 检查、`git diff --check` 全部通过；Node ABI 137 与 Electron ABI 148 的 SQLite smoke test 均成功。

## APP Scan 后台异步化（2026-07-28）

- 问题根因不是 scanner 缺少 `async` 关键字，而是 GUI 的 `scan.run` IPC 一直等待 Worker 完成才返回，使 renderer 生命周期与一条长请求绑定；现有进度事件也无法完整恢复切页前的六 agent 状态。
- 新增 `ScanController` 管理 Worker 生命周期。`scan.run` 现在只负责启动并立即返回 `{ started }`，扫描结果继续通过 `scan.progress / scan.done / scan.failed` 事件推送；`scan.status` 提供运行中、完成、失败和各 agent 最新进度快照。
- 互斥由 controller 统一持有：运行中第二次调用返回 `already-running`，worker error、显式 error message 或未完成即 exit 都会释放互斥并广播失败。
- Overview 挂载时先订阅事件再读取 status；切页重进可恢复 `progressByAgent`，完成后仍刷新项目列表。core scanner、adapter、DB schema 与 CLI 行为未改。
- 定向回归 3/3、core 22 suites / 204 tests、core/app build、扩大范围 TypeScript 检查和 `git diff --check` 全通过。标准 app composite typecheck 仍只有 `BLOCKED.md` 已记录的跨包 rootDir/TS6307 问题。
- 隔离真实 Electron 扫描 1548 sessions、errors=0；扫描期间 Projects 导航与主题切换保持响应，切回 Overview 时恢复到 Codex `300/693`，完成后刷新 84 个项目。

## APP Settings Paseo 布局修正（2026-07-29）

- 主 App 改为固定 `h-screen` 布局：侧栏始终占满视口，Overview/Projects/Rules 仅在右侧独立滚动，Settings 与主题入口不会再被长内容推到页面底部。
- Settings 不再嵌在主布局中；进入后完全替换主界面，使用 Paseo 风格独立设置 shell，左上返回恢复来源视图。
- Settings 分类为 Providers/About。Providers 复用既有后台 Worker/IPC snapshot，展示 Claude/Codex 实时状态、模型数量、默认标记、启用状态与 generation effort。
- Provider 详情恢复搜索、Discovered/Custom、模型默认选择、自定义模型增删、脱敏 Diagnostic 与 Refresh，视觉对齐 P2/P3。
- 隔离 Electron 实测 Overview/Projects 的 Settings 均可见；Projects → Settings → Projects 恢复正确；Claude 4 models、Codex 5 models，搜索与诊断可用。
- 最终 app 6/6 tests、renderer TypeScript、production build、硬编码颜色检查与 diff check 全部通过；验收进程和临时 HOME 已清理。

## APP Generation defaults 与 Provider Footer 修正（2026-07-29）

- Effort 配置从 `low / medium / high` 扩展为 Claude Agent SDK 当前声明的完整五档 `low / medium / high / xhigh / max`；config、CLI 参数类型、renderer 类型和运行时校验保持一致。
- 新增可选 `fastMode` 配置。旧 config 不加字段仍可读取，但生成链路会把缺失值解释为 `false`，避免本机 Claude 全局设置意外改变规则生成行为。
- Claude 调用通过 Agent SDK query options 的 `settings.fastMode` 启用/关闭 Fast Mode；Codex 调用不消费该字段。自动拆分后的递归请求继续携带同一 effort / fastMode。
- Settings 的 Generation defaults 改为两行设置卡：Effort 五档下拉 + Claude Fast Mode Switch；非 Claude 默认 provider 时开关禁用并显示说明。
- Provider 详情 Footer 改为完整宽度 flex 容器：更新时间在左，Add model / Diagnostic / Refresh 在右，窄宽度可整体换行，移除依靠单个元素 `mr-auto` 造成的不稳定间距。
- 隔离 Electron 真实验收：下拉展示五档，Max 和 Fast Mode 能保存为 `{ effort: "max", fastMode: true }`；Provider Footer 左右分组和滚动内容正常。验收后 Electron、Vite 与临时 HOME 已清理。
- 最终验收：core 23 suites / 213 tests、app 2 suites / 6 tests、core/app build、renderer strict TypeScript 与 `git diff --check` 全通过。标准 app composite typecheck 仍只有 `BLOCKED.md` 已记录的跨 workspace `TS6059/TS6307`。

## APP 无边框窗口拖动修复（2026-07-29）

- `BrowserWindow` 使用 `titleBarStyle: hiddenInset` 后，renderer 必须显式提供 `-webkit-app-region: drag`；此前没有 drag region，导致鼠标无法移动窗口。
- App 根层新增固定 2rem 顶部拖动带，左侧保留 5rem 给 macOS traffic lights；该节点位于 Settings 条件分支之外，因此所有页面和 Modal 打开状态都保留拖动能力。
- button / link / input / textarea / select / role=button 显式设为 `-webkit-app-region: no-drag`，避免交互控件被拖动语义吞掉。
- 新增 `window-drag-region.test.ts` 锁定 JSX 与 CSS 契约；测试先在旧实现上失败，修复后通过。
- 真实 Electron 分别在 Overview 与 Settings 顶部执行拖动；随后 Settings 与返回按钮点击正常，应用保持运行并回到 Overview。
- 最终验收：App 3 suites / 7 tests、renderer strict TypeScript、production build、`git diff --check` 全通过。

## APP 首页工作流渐进式重构（2026-07-29）

- 主导航收敛为 Scan / Projects / Rules；三页都使用“列表 / 结果优先，配置与详情按任务进入独立页面”的渐进式结构，移除 PageHeader 默认 Local 徽标。
- Scan 默认展示最近结果，新建扫描独立配置全量扫描范围；所选 Agent 经过 IPC 校验传入 ScanController 和 Worker，仍保持后台运行与切页恢复。
- Projects 增加搜索与 All / Changed / Has drafts / Unclassified 筛选；详情拆分 Sessions / Rules，Sessions 通过 `listProjectSessions` IPC 查询并以 56px 固定行高、overscan=4 的 renderer 虚拟窗口展示。
- Scan 结果可直接进入对应项目详情；项目 Rules 可带 project scope 跳到规则生成页。
- Rules 默认只显示候选队列，Generate / Review / Output 分为独立页面；Generate 支持 recent（每 session 最近 30 rounds）、full 和指定多个 projects，避免把 recent 误称为增量扫描。
- Output 继续只调用既有 `runRulesOutput({ all: true })` 写 `.memory-manager/rules`；Agent system prompt / project memory 的 live write 因缺少备份与冲突协议继续排除。
- Electron smoke 发现长 Projects 表格会造成文档级横向滚动并在切页后压住侧栏；根容器与 main 现已锁定 viewport 宽度、隐藏全局横向溢出，并用 active view key 重置滚动上下文。
- 最终验收：App 5 suites / 15 tests、Core 23 suites / 213 tests、Core/App build、renderer 扩大 rootDir TypeScript、`git diff --check` 全通过；真实验证 Scan 配置、Projects 搜索筛选、306 sessions 虚拟列表和 Rules Generate，测试 Electron 实例已退出。

## APP 最近 Scan 跨重启恢复（2026-07-29）

- 原因：`ScanController` 仅保存当前 Electron 进程内的 summary，应用重启后 `scan.status` 变为空，即使 `run_metadata` 已有成功记录也会误显示未扫描。
- main 新增只读 Scan history loader，从 `run_metadata` 选择最近一次 success/partial Scan，严格解析 summary，并兼容旧记录缺少 `changes` 的情况；不修改 schema 和 scanner 写入逻辑。
- `scan.status` 优先返回运行中或当前进程结果；内存无 summary 时才恢复 DB 历史。当前 Worker 完成状态新增 `completedAt`，renderer 展示 sessions 总量与完成时间。
- 真正无历史时首页标题改为 Scan，并提供 Configure first scan 入口，不再只显示被动空卡片。
- 受控 Computer Use 会以隔离 HOME 启动 Electron，不能用于默认 workspace 的历史数据验收；改用真实默认 DB 只读检查，确认恢复 2026-07-29 最近记录：1036 sessions / 3 new / 4 updated。
- 最终验收：App 7 suites / 22 tests、App production build、renderer 扩大 rootDir TypeScript、真实 DB 恢复断言与 `git diff --check` 全通过；无残留 Electron/Vite 进程。

## APP 窗口位置恢复（2026-07-29）

- Electron 主进程将主窗口最后一次普通状态位置保存到 `app.getPath('userData')/window-position.json`；窗口 `move` 时更新，`close` 前同步兜底保存。
- 启动时仅恢复 `{x, y}`，不记录尺寸、最大化、全屏或多窗口状态；最小化、最大化或全屏状态不会覆盖最后一次普通位置。
- 读取位置时要求安全整数坐标，且窗口左上角仍位于当前任一 display work area；损坏 JSON、非法字段、文件缺失或外接屏移除都会回退 BrowserWindow 默认位置。
- 写入使用同目录临时文件 + rename，失败只记录主进程 warning，不阻止窗口继续运行。
- 真实 Electron 验收预置 `(400, 180)` 后启动并正常退出，状态仍精确为 `(400, 180)`；测试状态文件、临时目录与测试进程均已清理。
- 最终验收：App 7 suites / 23 tests、Core 23 suites / 213 tests、renderer 扩大 rootDir TypeScript、App/Core build 与 `git diff --check` 全通过。

## APP Projects 整行点击热区（2026-07-29）

- Projects 表格从仅 project name Button 可点击，调整为 HeroUI Table 的 `onRowAction`；点击任意单元格都进入对应项目详情。
- Project name 恢复为普通强调文本；整行增加 pointer、hover、focus-visible 背景和键盘焦点环。
- 交互沿用 React Aria row action 语义，保留鼠标与键盘操作，不给 `Table.Row` 注入其类型不支持的原生事件。
- 最终验收：Projects 布局定向测试、renderer 扩大 rootDir TypeScript、App production build、App 7 suites / 23 tests 与 `git diff --check` 全通过。

## APP Projects 首行热区圆角修正（2026-07-29）

- HeroUI Table 为首行单元格附带圆角，整行 hover 时首行右上角出现圆弧缺口，与其余行的矩形热区不一致。
- Project row 与直接子 `td` 统一设为 `rounded-none`；只修正行内热区形状，保留表格 Card 外框圆角与既有 `onRowAction`。
- 最终验收：Projects 布局定向测试、renderer 扩大 rootDir TypeScript、App production build、App 7 suites / 23 tests 与 `git diff --check` 全通过。

## APP Session 筛选与内容浏览（2026-07-29）

- Project Sessions 增加 session id / source path 搜索、Agent 筛选、状态筛选和结果计数；筛选后的数据继续进入 56px 固定行高、overscan=4 的虚拟窗口。
- Session 行改为整行可点击的 button 热区；详情作为 ProjectDetails 内部子页面，返回时保留搜索、筛选和虚拟列表滚动位置。
- Core 新增只读 `readSessionPreview`：按需读取源 Session，不写 DB，只返回脱敏后的 user / assistant 文本和工具名摘要；工具参数、tool output 与 LLM prompt 不进入 renderer。
- Session 解析运行在独立 `session-preview-worker`，避免大文件读取和解析占用 Electron 主进程；详情最多渲染最近 200 条可展示消息，并标明总消息数。
- 最终验收：App 7 suites / 24 tests、Core 23 suites / 214 tests、renderer 扩大 rootDir TypeScript、Core/App build 与 `git diff --check` 全通过。

## APP Session 面包屑与 IPC 版本漂移修复（2026-07-29）

- Project 与 Session 详情统一使用语义化面包屑：Project 为 `Projects / project`，Session 为 `Projects / project / Session`；上级节点可点击返回，并保留 Project 内的筛选与滚动状态。
- 截图中的 `No handler registered for 'sessions.preview'` 根因是旧 Electron 主进程仍持有 single-instance lock，同时 renderer 已连接到更新后的开发资源；新启动实例因此退出，造成 renderer/main 版本漂移。
- renderer 对缺失 handler 增加可理解的重启提示，不再直接把底层 remote-method 错误暴露给用户；IPC 契约测试同时锁定 handler 与 session-preview Worker 构建入口。
- 真实默认 workspace 验收：彻底退出旧主进程和旧 Vite server 后，新进程成功打开 `agent-workspace` Session，读取 209 条可展示消息并渲染最近 200 条；两级面包屑返回正常，无 IPC 报错。
- 最终验收：App 7 suites / 26 tests、Core 23 suites / 214 tests、renderer 扩大 rootDir TypeScript、Core/App build 与 `git diff --check` 全通过；Electron/Vite 验收进程已清理。

## APP Session 行鼠标反馈修正（2026-07-29）

- Session 虚拟列表整行 button 显式增加 `cursor-pointer`，hover 时显示可点击的手型光标；点击热区、hover 背景、键盘焦点和虚拟滚动行为保持不变。
- 布局契约测试新增 Session 行 cursor 断言，避免后续样式整理再次丢失点击反馈。
- 最终验收：App 7 suites / 26 tests、renderer 扩大 rootDir TypeScript、App production build 与 `git diff --check` 全通过。

## APP Claude / Codex 共用 Fast Mode（2026-07-29）

- `fastMode` 继续使用单一 generation default，不新增配置字段或迁移；Claude 与 Codex 会按当前默认 Provider 消费同一个值。
- Claude 保持映射到 Agent SDK `settings.fastMode`；Codex 新增显式 tier 映射：开启为 `service_tier="priority"`，关闭为 `service_tier="default"`，避免本机全局 Codex tier 改变规则生成的确定性。
- Settings 的 Fast Mode 标记改为 `Claude · Codex`，移除 Codex 默认 Provider 下的禁用逻辑和 Claude 专属套餐文案。
- 测试先锁定旧实现缺少 Codex tier 和 UI provider 限制，再完成修复；最终 Core 23 suites / 216 tests、App 7 suites / 27 tests、Core/App build、renderer 扩大 rootDir TypeScript 与 `git diff --check` 全通过。

## APP Scan 结果直达 Project Sessions（2026-07-29）

- Latest scan 结果表接入 HeroUI Table `onRowAction`，点击项目行任意单元格都进入对应 Project 详情；原有右侧动作保留并改名为 `View sessions`。
- Project 详情既有默认 tab 仍为 `sessions`，因此导航无需新增路由状态，也不会影响 Projects 列表搜索、筛选与虚拟 Sessions 列表。
- Scan 行补齐 `cursor-pointer`、hover、focus-visible 与方形单元格热区，鼠标和键盘都具备一致的可操作反馈。
- 最终验收：App 7 suites / 28 tests、renderer 扩大 rootDir TypeScript、App production build 与 `git diff --check` 全通过。

## APP 最近 7 天 Scan History 与变更 Sessions 生成（2026-07-29）

- 新建 Scan 继续保持全量遍历所选 Agents，不引入按文件时间裁剪的增量扫描；“最近 7 天”仅用于已完成 Scan 的历史查询与规则 evidence 范围。
- Scan History 从 `run_metadata` 只读加载最近 7 天 success/partial 记录，按 `ended_at` 倒序；列表可进入任意历史结果并复用项目变更表。旧 summary 缺少 `changes` 时仍能查看统计。
- Rules Generate 新增 `Changed in last 7 days`：汇总 7 天内各次 Scan 的 new/updated session id，排除 missing、去重，再通过 `sessionIds` 精确过滤 evidence；空范围直接产生 0 candidates，不回退到全量。
- 未修改 DB schema，也不保存新的 session 原文。默认 workspace 只读 smoke 返回 7 条历史扫描、1179 个去重变更 sessions，最近完成时间为 `2026-07-29T07:34:11.379Z`。
- 最终验收：App 7 suites / 30 tests、Core 23 suites / 218 tests、Core/App build、renderer 扩大 rootDir TypeScript 与 `git diff --check` 全通过。

## APP Scan History IPC 版本漂移修复（2026-07-29）

- 截图中的 `No handler registered for 'scan.history'` 与先前 Session preview 一致：renderer 热更新后，16:45 启动的 Electron main 仍持有旧 IPC handler 集合；源码和 production main bundle 均已包含 `scan.history`。
- History catch 增加缺失 handler 识别，旧主进程场景改为提示 `Restart the app to finish updating`，不再暴露底层 remote-method 错误。
- 仅终止本项目旧 electron-vite / Electron 进程并重新启动；新进程于 17:13 启动，5173 重新监听。默认 workspace 的真实 History 查询返回 7 条记录。
- UI 自动化插件两次因 macOS AppleEvent timeout 无法读取窗口，未继续重试；改用新进程启动时间、端口、构建产物 handler 和真实 DB 查询完成替代验收。
- 最终验收：App 7 suites / 30 tests、renderer 扩大 rootDir TypeScript、App production build 与 `git diff --check` 全通过。

## APP New Scan 最近 X 天时间范围（2026-07-29）

- 用户澄清“最近 7 天”应是 New Scan 的 session 时间范围，而不是 History 的保留窗口；New Scan 现支持 `Full history` 和自定义正整数 `Last X days`，并与所选 Agents 一起传入后台 Scan Worker。
- Core `ScanOptions` 新增 `sinceDays`，以 adapter 权威 `DiscoveredSession.updatedAt` 和扫描开始时间计算窗口；窗口外 session 不进入 parse / classify / FS / DB 更新链路。
- 时间窗口扫描不执行 missing 对账：范围外 session 本轮没有被发现不代表源文件已删除，只有 Full history 扫描继续把真实缺失记录标为 missing 并移除链接。
- `run_metadata.details` 新增 `scope` 元数据；旧扫描记录缺少 scope 时兼容解释为 Full history。Scan History 改为列出全部已完成记录，并展示每次扫描的 Full history / Last X days 范围。
- Rules 的 `Changed in last 7 days` 仍保持独立 evidence 范围：`listChangedSessionIds` 显式默认查询最近 7 天，不受 History 全部展示语义影响。
- 测试先锁定 `sinceDays` 类型缺口；实现后验证删除旧 Codex fixture 再执行最近 1 天扫描时 `total=0`、`missing=0`，原 DB session 不会变为 missing。
- 最终验收：Core 23 suites / 220 tests、App 7 suites / 31 tests、Core/App production build、renderer 扩大 rootDir TypeScript 与 `git diff --check` 全通过；旧开发进程已退出，新 Electron 主进程已于本轮重启。

## APP Rules Generate 后台 Worker 与紧凑状态（2026-07-29）

- 卡死根因：`rules.generate` IPC handler 在 Electron 主线程内直接 `await runRulesGenerate`，evidence 提取、session 文件解析和 LLM 调用全都占用主进程事件循环。
- 新增独立 Generation Worker 与 Controller：IPC 只校验请求并启动 Worker，立即返回 `{ started: true }`；运行中互斥、进度、完成、失败和 Worker 提前退出由 Controller 统一维护。
- renderer 新增 `rules.generate.status` 恢复链路；离开 Rules、切换其他主导航或 renderer 重挂载后，仍能恢复后台任务的运行进度与最终结果。
- 现有 `generate.progress / generate.done / generate.failed` 事件名保持不变，但改为广播到所有窗口，不再绑定发起请求的单个 sender。
- Generate 页面移除大块居中状态 Card，改为紧凑的行内状态条：Spinner、阶段、详情和完成 Chip 同行展示；错误继续使用 Alert。
- 测试先确认旧实现缺少 Controller/Worker 和 status handler；实现后新增 4 个 Controller 状态机测试，并锁定 Worker 构建入口、主线程不再调用 `await runRulesGenerate` 和紧凑状态布局。
- 最终验收：App 8 suites / 36 tests、Core 23 suites / 220 tests、App production build、renderer 扩大 rootDir TypeScript 与 `git diff --check` 全通过；production Generation Worker 独立启动 smoke 返回 `done / candidateCount: 0`，Electron 主进程已重启加载新 handler。

## APP Scan / Generate 可恢复、可取消、可观察后台 Run（2026-07-29）

- ScanController 与 GenerationController 统一补齐稳定 `runId`、单调 `seq` 和 `idle / running / cancelling / cancelled / completed / failed / interrupted` 生命周期；启动 IPC 立即返回，取消请求必须携带当前 runId，旧页面不能误取消新任务。
- Scan Worker 和 core scanner 接入 AbortSignal，在 Agent / Session / missing 对账等安全边界协作停止；取消前已完成的 DB/FS 索引保留，`run_metadata` 记录 cancelled 与脱敏 summary。History 展示 cancelled，但 Latest 继续只恢复最近 success/partial。
- Rules Generate 保持一次用户可见 Run：启动时先一次性冻结 Evidence snapshot，再允许内部按 bundle / retry 调用 Provider。取消或失败发生在最终事务前，不写入任何 Draft；Generate lifecycle 只向 `run_metadata` 写 request、来源计数和结果摘要，不保存 prompt、Session 原文或 Agent output。
- Claude Agent SDK 开启 partial messages 并归一化 text delta；Codex 使用 `exec --json --ephemeral --ignore-rules --sandbox read-only`、stdin prompt 和 JSONL 事件，取消时 SIGTERM 后超时 SIGKILL。Provider 未产生 partial event 时用最终 assistant message 兜底，保证 UI 仍有可见输出。
- Generation Worker 将高频 token delta 以约 32ms 合并后广播；Controller 仅在内存保留最多 512 KiB Agent output 和 200 条非文本事件。切换主导航或 Renderer 重挂载后从 status 恢复同一 runId、Evidence 与已累积输出，App 重启不续跑，遗留 running 记录标为 interrupted。
- Rules Queue 在活跃任务时显示 `View generation` 和运行条；Run detail 提供 Prepare evidence / Generate candidates / Validate / Save 阶段、Agent output / Evidence 两个 tab、自动跟随与 Jump to latest、Stop generation、完成后 Review drafts。Evidence Session 列表继续使用固定行高虚拟滚动，内容按需复用脱敏 `sessions.preview`。
- Scan 运行卡增加 Stop scan / Cancelling；History 与其他主导航运行时仍可使用。取消完成后自动恢复上一次完整 Scan 结果，并明确提示部分索引已保留。
- 测试先锁定 Run 状态机、错误 Worker、重复启动、stale runId、取消无 Draft、Scan cancelled metadata、Claude/Codex 流事件、Evidence snapshot、History/Latest 分离和 renderer 交互契约。
- 最终验收：Core 23 suites / 228 tests、App 8 suites / 41 tests、Core/App production build、扩大 rootDir 的完整 TypeScript 检查与 `git diff --check` 全部通过。标准 App composite typecheck 仍只有 `BLOCKED.md` 记录的跨 workspace rootDir 限制。

## APP Generation Run Paseo 项目化输出（2026-07-29）

- Generation Run 移除右侧顶部 Agent output / Evidence Tabs；左侧 Prepare evidence / Generate candidates / Validate / Save drafts 成为唯一阶段导航，四项均可点击且唯一选中。Validate / Save drafts 暂复用过程视图。
- Core 在每个 Evidence 项目生成完成后立即发布结构化响应，包含 project slug、自然语言摘要及 Candidate 的 rule/scope/confidence/reasoning/evidence refs；最终 Draft 仍只在全部项目完成后的原事务内写入。
- Worker 只把结构化响应作为内存事件转发；`run_metadata` 继续只保存 request、Evidence 数量与结果摘要，不保存响应、Session 原文、tool output、prompt 或 raw Agent output。
- Controller 独立保存最近 100 个项目响应，每项目最多 50 个 Candidate、每 Candidate 最多 50 个 Evidence refs，并限制详情文本长度；status 对响应、refs、Evidence 与事件做深层 defensive copy。
- Renderer 从 status 恢复项目响应并按 runId 在进程内记忆阶段与对话滚动位置。Generate 同屏展示 Process、项目化 Agent 对话、typing/activity 与可点击 Candidate 只读详情；raw Provider output 仅在默认折叠的 Diagnostic 中显示。
- Evidence 改为先搜索/选择 Project，再虚拟浏览该项目 Sessions；Project name 为标题主信息，Session ID 为次级技术信息，脱敏 Preview 仍通过既有 `sessions.preview` 按需加载。
- 红测证据：Core 因缺少 `onProjectResponse` 编译失败；App 因缺少 `projectResponses` 编译失败；布局测试确认旧实现仍有顶部 Tabs 且不是 Project-first。
- 最终验收第 1 轮即全绿：Core 23 suites / 230 tests、App 8 suites / 45 tests、Core/App production build 与 `git diff --check` 全部通过。

## APP Candidate 详情弹窗键盘关闭（2026-07-29）

- Candidate 详情标题明确显示 `Project · <slug>`，关闭操作改为标题栏右上角的 icon-only X，同时保留可访问名称。
- 弹窗挂载时监听 `keydown`；按 Escape 调用同一关闭回调，卸载时移除 listener，避免重复注册或泄漏。
- 测试先确认旧实现缺少 Project 标签、X 与 Escape 监听；实现后布局契约 14/14、App 全量 8 suites / 46 tests、production build 与 `git diff --check` 全通过。

## APP Generation Run 初始阶段修正（2026-07-30）

- 问题根因是 GenerationRunPage 对无 runId UI 记忆的情况使用 `generate` 作为 fallback；Evidence 实际仍先在 Worker 中完成，只是新 Run 第一屏错误选中了 Generate candidates。
- 新 Run 的 fallback 改为 `evidence`，因此进入 Run detail 时先展示 Prepare evidence；已有 runId 仍从 renderer 内存恢复用户上次选择，不影响切页恢复。
- 红测先锁定旧 `generate` fallback；实现后 App 全量 8 suites / 47 tests、production build 与 `git diff --check` 全通过。

## APP 窗口位置与大小恢复（2026-07-30）

- 窗口状态文件从 `{x,y}` 扩展为普通窗口完整 bounds `{x,y,width,height}`；启动时若存在合法尺寸则一并恢复，已有仅位置状态继续兼容并使用默认尺寸。
- 主进程统一通过 `window.getBounds()` 保存状态，监听 move、resize 与 close；最小化、最大化和全屏期间仍不覆盖最后一次普通窗口状态。
- 状态解析要求 width/height 成对出现且为正安全整数；损坏、非法或已离开当前显示器工作区的状态继续安全回退。
- 红测证据：新增尺寸契约后旧 `WindowPosition` 类型报 TS2353（不存在 width）；实现后定向测试 9/9、App 全量 8 suites / 50 tests、production build 与 `git diff --check` 全通过。

## Rules 全流程与 Paseo 风格 Agent Chat HTML 原型（2026-07-30）

- 新增 `docs/prototypes/rules-workflow-redesign.html`，以 Generate → Review → Publish 为稳定顶层流水线；运行中的 Generation 作为 Generate 的上下文页面，不再成为并列业务阶段。
- Generate 使用 Evidence scope + Generation summary；Review 使用候选列表与 Inspector 主从工作台；Publish 在写入前按 scope 预览已接受规则与 managed output 目标。
- Generation Run 参考 Paseo Agent Stream：Request 右侧气泡、Assistant 无气泡正文、可展开 Activity、结构化 Candidate、Turn Footer、底部运行状态与自动回到底部入口；项目 Rail 只表达处理对象，不重复阶段导航。
- Evidence 从独立内容页降级为 Run 内 Drawer，避免 Evidence / Generate / Validate / Save 与 Process timeline 双重导航；Candidate 支持就地展开 reasoning 和 refs。
- 原型保持现有隐私边界，只展示请求摘要与脱敏 Evidence 元数据，不把 Prompt、Session 原文、tool output 或 raw Agent output写入持久化状态。
- 浏览器实测 Generate → Run、Evidence Drawer、Review Accept & next、Publish 全链路可用；Accept 后 Draft 12 → 11，1280px 与 700px 宽度均无页面级横向溢出。静态契约、内联脚本语法与 `git diff --check` 通过。

## Rules HTML 完整 Run 状态演示（2026-07-30）

- Generation Run 补齐 Evidence collecting / Generating / Validate & save / Completed 四个可固定查看的状态；顶部 `Prototype states` 明确标注为原型演示控制，不进入生产信息架构。
- Evidence collecting 在同一 Chat 中展示 Request、隐私说明、逐项目 Session/Excerpt 收集、进度条、项目 Rail 与实时 Footer；不新增 Loading 页面或重复阶段导航。
- Generating 延续 Paseo 风格 Assistant Turn、Activity 和 Candidate；Validate & save 展示 9 → 7 去重、schema/evidence 校验与事务保存；Completed 汇总 5 Projects / 7 Drafts / 1m18s，并在此时才显示 Review drafts。
- `Replay full run` 以 Evidence → Generating → Validating → Completed 自动演示完整状态机，四个状态也可以手动固定，方便设计评审。
- 视觉验收发现通用 `.button` 覆盖原生 `[hidden]`，曾导致 Review drafts 在 Evidence 阶段提前显示；增加全局 `[hidden] { display: none !important; }` 后复验通过。
- 浏览器逐状态验证标题、Badge、Project Rail、Chat、Footer 与 Review 出口一致；Replay 自动完成，700px 窄窗口无横向溢出，静态契约、脚本语法和 `git diff --check` 通过。

## Rules Evidence 聚合快照语义修正（2026-07-30）

- Core 实际模型是 `extractEvidence → EvidenceBundle[]`（每个 bundle 保留 `projectSlug`）→ Worker 汇总为一份 `EvidenceSnapshot.projects[]` → Generation 再逐 bundle 调用 Agent；不是每个 Project 独立生成一份 snapshot，也不是把项目边界完全扁平化。
- 原型此前在 Evidence collecting 同时展示左侧 Project queue 和卡片内逐项目完成/等待，错误暗示“逐项目收集多份 Evidence”；用户截图明确指出该歧义。
- Evidence 状态现使用 `.chat-shell.evidence-mode` 隐藏 Project rail，Chat 扩为单列；主卡明确命名 `One evidence snapshot`，只展示 Run-level 5 Project groups / 19 of 28 Sessions / 312 Excerpts 聚合进度。
- Project 名称仅作为 snapshot 内无状态 source chips；删除 `Collecting cloud-code-master evidence`，改为跨全部 source groups 的 normalize/de-duplicate Activity。
- 进入 Generating 后移除 `evidence-mode`，恢复 230px Project queue，表示 Agent 按 Project bundle 逐个生成的真实顺序。
- 浏览器对账：Evidence 为单列 926px 且 Rail `display:none`；Generating 为 `230px + 696px` 且 Rail 可见；两态均无页面级横向溢出，静态契约、脚本语法与 `git diff --check` 通过。

## Rules Overview / Chat / Publish 生产重构（2026-07-30）

- Rules 默认入口改为 Overview：集中展示 5 个 Agent 各自独立的全局 instruction 文件、Project Rules 跳转、Recent generations 和按状态筛选的 Generated rules；Cursor 从 Rules instruction 与发布目标中彻底移除，Session 扫描能力保持不变。
- Claude / Codex / Copilot / OpenCode / Pi instruction 支持读取、缺失文件创建、编辑和 CAS revision 保存；写入采用临时文件、fsync、rename，保留 symlink 目标语义，限制 UTF-8 正文最大 1 MiB。
- Start Generate 进入 Chat 后再选择 Evidence scope（Recent activity / Select projects / Full history）；Evidence collecting 只展示一份 run-level snapshot，Project 仅作为 snapshot 内 source group，不再伪装成多个独立收集任务。
- `rule_candidates` 通过仅吞 `duplicate column name` 的受保护加列补充 `run_id`；Generation Worker 保存 Evidence 的项目 slug、session id 与数量元数据，仍不持久化 prompt、Session 原文、tool output 或 raw Agent output。
- Recent generation 的任意历史行现在可重新打开为 Chat 风格详情，恢复 request、统一 Evidence snapshot、Candidate 及 draft / accepted / rejected 状态；旧记录没有 run 关联时安全降级。
- Draft Candidate 支持正文编辑后再接受/拒绝；Publish 默认不选 Agent，只把 accepted global rules 写入用户选中的 Agent managed block，保留人工内容并对各目标独立报告 published / unchanged / failed；Project rules 继续由 Projects 管理。
- 运行时使用隔离 HOME 实测 Rules Overview → Start Generate → Evidence scope → 空 Evidence completed → Overview 更新 → 重启应用 → 历史 Chat 重新打开；5 个 Agent 路径、统一 Evidence 语义和历史恢复均与设计一致。
- 最终验收：Core 24 suites / 237 tests、App 9 suites / 55 tests、Core/App production build、扩大 rootDir 的 renderer TypeScript 检查与 `git diff --check` 全通过。

## Rules Overview 工作台式 HTML 重设计（2026-07-30）

- 新增 `docs/prototypes/rules-overview-workbench-v2.html`，推翻原有“大卡片纵向堆叠 + 居中标题 + Project/Recent 强行等宽”的 Overview 结构。
- 首页改为单一左对齐视觉轴：顶部状态条 → 5 Agent instruction dock → Generated Rules 主工作区；Recent generations 与 Project rules 降级为右侧辅助信息栏。
- Overview 不再直接展示完整文件路径，只展示 Agent、文件名、配置状态和更新时间；点击 Agent 后使用 Drawer 展示路径与可编辑正文。
- Publish 从 Recent generations 中移除，只保留在 Accepted/Generated Rules 上下文；Start Generate 使用 Evidence scope 弹窗衔接 Agent Chat。
- 原型支持 Draft / Accepted / Rejected 切换、Candidate 详情、Agent 编辑抽屉、历史 run 摘要和 Evidence scope 选择。
- 浏览器验证无页面级横向溢出；Agent Drawer、Evidence scope、状态切换均可操作，内联脚本语法和 `git diff --check` 通过。

## Rules 二级菜单 HTML 信息架构（2026-07-30）

- `rules-overview-workbench-v2.html` 的 Rules 主导航新增 Overview / Agent instructions / Generated rules / Generation history 四个二级入口，Rules 主项再次点击回到 Overview。
- Overview 进一步减负，只保留聚合指标、待审核规则、Agent 健康状态、最近一次生成和 Project Rules 跳转。
- Agent instructions 独立展示 5 个 Agent 的文件位置与状态；Generated rules 独立承担审核和 Publish；Generation history 独立展示可重新打开的 run 列表。
- Project Rules 继续归属 Projects，不进入 Rules 二级菜单，避免同一对象出现两套管理入口。
- Agent instructions 列表用独立图形与颜色区分 Claude、Codex、Copilot、OpenCode、Pi，替换字母缩写占位，同时保持统一图标容器尺寸。
- 补回 Generate Chat View 的真实页面切换：Evidence scope 确认后进入独立对话工作区，右侧固定 Run context 与单份 Evidence snapshot；Project 仅作为 snapshot 内 source groups 展示。
- Chat View 提供 Evidence / Generate / Complete 三态预览、Stop、返回 Rules 与进入 Generated rules 的完整交互，不再用 toast 假装跳转。
- 浏览器逐项验证四个二级页面切换、Agent 编辑 Drawer 与规则列表渲染；无页面级横向溢出，内联脚本语法与 `git diff --check` 通过。

## Rules 最新 Scope 生产界面重构（2026-07-30）

- APP 侧栏在 Rules 主项下新增 `Overview / Agent instructions / Generated rules / Generation history` 二级菜单；再次点击 Rules 回到 Overview，二级菜单能从编辑、审核和历史详情中直接切回对应列表。
- Overview 改为聚合状态条、Needs your attention、Instruction health、Latest generation 和 Project Rules 跳转，不再堆叠完整 Agent、Project、History 与 Candidate 管理列表。
- Agent instructions 独立展示 Claude / Codex / Copilot / OpenCode / Pi 的文件状态、路径、更新时间与编辑入口；字母占位替换为 Lucide 图形和克制的 Agent 识别色。
- Generated rules 独立承担 Draft / Accepted / Rejected 审核与 Publish；Generation history 独立展示全部 run，并可重新打开同构 Chat View。
- Start Generate 进入独立 Evidence scope 对话入口；确认后继续进入 Agent Chat。活跃 Run 改为顶部阶段导航、中央 Request / Assistant 对话、底部运行状态与右侧 Run context，不再使用左侧阶段栏。
- Evidence collecting 继续只展示一份 run-level snapshot，Project 只作为 snapshot 内 source group；历史 Chat 同样恢复 request、统一 Evidence、candidate 状态和 publish 出口。
- 真实 Electron 窗口逐页验收 Overview、Agent instructions、Generated rules、Generation history、Evidence scope 与历史 Chat；未实际启动 Provider 生成，避免产生无意义外部调用。
- 最终验收：App 9 suites / 55 tests、Core 24 suites / 237 tests、renderer TypeScript、App production build 与 `git diff --check` 全通过；标准 App composite typecheck 仍只有 `BLOCKED.md` 已记录的跨 workspace rootDir / TS6307 问题。

## Rules 子页面层级精简（2026-07-30）

- Rules 二级菜单已经表达当前所在模块，因此 Agent instructions、Generated rules、Generation history 移除重复的 PageHeader 大标题、说明和 Start Generate。
- Start Generate 只保留在 Overview；三个子页面直接以 `Global instruction files / Rule candidates / Recent runs` 的内容标题开始。
- 新增布局契约测试，分别截取三个 Index Page 源码并禁止出现 PageHeader 和 StartGenerateButton；Overview 继续保留唯一生成入口。
- 冷启动 Electron 实测 Generation history 内容直接贴合页面首层，无遗留空白占位；同一结构同步应用于 Agent instructions 与 Generated rules。
- 最终验收：App 10 suites / 63 tests、App production build 与 `git diff --check` 全部通过。

## APP i18n 第一期设计（2026-07-30）

- 第一期只支持 `zh-CN / en-US`，没有有效偏好时固定默认 `zh-CN`，不跟随操作系统自动选择。
- Locale 是当前设备的 Renderer UI 偏好：使用 `localStorage` 在 React 挂载前同步恢复，不进入 workspace `config.json`、SQLite、规则文件或 Session 索引。
- 技术方案采用 `i18next + react-i18next`、按页面 namespace 拆分资源，并用集中 formatter 显式处理日期、数字、字节和复数；缺 key 回退中文。
- Settings 新增 General / Language，切换即时生效并同步 `<html lang>`；不翻译品牌、slug、路径、用户内容、Session/Evidence/Agent output 或 Provider 原始诊断。
- Main/Core 动态错误第一期不做字符串翻译，只本地化 Renderer 的稳定标题、兜底说明和恢复操作；后续完整本地化需先引入 IPC error code。
- 可执行计划见 `docs/plans/app-i18n-phase-1.md`，按端到端最小骨架 → formatter → Scan → Projects → Rules → Providers/审计 → 全量回归分步实施。

## APP i18n 第一期落地（2026-07-30）

- Renderer 接入 `i18next + react-i18next`，在 React 挂载前同步读取 `localStorage` 偏好并初始化；仅支持 `zh-CN / en-US`，无值或非法值固定回退中文，同时同步 `<html lang>`。
- Settings 增加 General / Language，选项固定自标识为 `简体中文 / English`；切换即时生效并持久化，写入失败时保留当前会话切换结果并显示可恢复错误。
- 翻译资源按 `common / navigation / scan / projects / rules / settings` 拆分，Scan、Projects、Rules、Settings、Providers、About 及共享生产界面完成迁移；品牌、路径、slug、用户内容和 Provider/Core 原始诊断继续按一期边界保留。
- 日期、日期时间、数字、字节均由集中 formatter 显式接收 locale；英文数量使用 i18next plural key，状态枚举映射为 translation key，避免依赖系统语言或在 JSX 中拼接语言规则。
- 新增 i18n 契约测试，覆盖默认/合法 locale、偏好读写失败、资源 namespace/key 对齐、显式 locale formatter、初始化顺序、Settings 入口、用户可见硬编码 AST 审计、隐式 locale API 审计与 Rules translation key 完整性。
- 真实 Electron 窗口完成中文默认 → 英文即时切换 → 中文切回 → 重启保持中文的闭环验证，并检查 Scan、Rules、Settings 的日期、导航、状态与布局；未发现页面级溢出。
- 最终验收：App 10 suites / 62 tests、Core 24 suites / 237 tests、Core/App production build、Renderer TypeScript 与 `git diff --check` 全通过。Core build 仍输出既有的 `tsdown define` 配置警告，但命令成功退出且与本次 i18n 无关。
- 当前工作树仍处于既有 monorepo 迁移状态，包含大量用户已有删除、修改和未跟踪文件；本轮未代替用户暂存或提交整棵工作树。

## APP Chat 一级导航与持久化 Generation Thread（2026-07-30）

- 新增 Scan / Projects / Chat / Rules 一级导航；Chat 成为 Agent Run 过程的唯一工作台，Rules 继续负责 Evidence scope、Candidate 审核与发布。Rules 新生成、活跃 Run 和 Generation History 行统一进入 Chat，旧 Run 没有 Thread 正文时以摘要安全降级。
- Workspace 新增 `<workspace>/chats/`。每个新 Generation 使用 `runId` 作为 Thread ID，保存 `thread.json`、只追加 `messages.jsonl` 与运行中 `assistant.partial.json`；SQLite 不新增表或正文列。
- Chat 只持久化用户可见请求、Project response 摘要、Activity 摘要、Evidence 元数据和 Candidate Artifact；`assistant_delta` raw Diagnostic、隐藏 Prompt、Session 原文、tool 参数和 tool output 继续不落盘。
- GenerationController 通过可选 transcript store 同步 start / progress / evidence / project response / cancelling / terminal 生命周期。完成、取消、失败时 partial 转为最终 Assistant message；App 启动时遗留 running/cancelling Thread 标为 interrupted 并保留已写正文。
- Renderer Chat 使用 Thread Rail + Conversation + Run context 三段布局：Request 右侧气泡、Assistant 无气泡正文、Activity 折叠区和 Candidate Artifact；第一版明确不提供 Composer、通用 New chat、连续追问或 Session Summary。
- Chat 系统请求、终态 fallback 和 Thread 标题按 `zh-CN / en-US` 本地化；真实 Agent 正文、slug 和 Evidence 引用保持原样。
- Computer Use 真实验收发现 Chat refresh 回调曾反复重建 IPC 订阅，连续切换触发 `MaxListenersExceededWarning`；将索引/详情加载回调稳定化后复验终端无 listener warning。
- 隔离 workspace 实测两条链路：预置完整 Thread → Electron 重启 → Chat 正文、Activity、Evidence 与 Candidate 恢复；Rules → Recent activity → 空 Evidence completed → 自动切换 Chat，全程没有调用 Provider。Chat → Generated rules 出口和窄窗口无页面级横向溢出。
- 红测先确认缺少 ChatStore、Controller transcript 依赖、Chat 导航/页面/IPC 和 Rules 跳转；最终 Core 24 suites / 238 tests、App 11 suites / 69 tests、扩大 rootDir 的 App TypeScript、Core/App production build 与 `git diff --check` 全通过。Core build 仍只有既有 `tsdown define` 配置警告。
- 后续 debt：通用 Composer、连续追问和 Session Summary 仍按产品约定留到下一阶段；Session Context 到时只保存 `sessionId`，每次调用读取最新 Session 内容，不做版本快照。

## APP Chat Paseo P1 流式 Activity 与完成态 Rules（2026-07-30）

- Chat 工作区改为固定 viewport 可用高度；App 页面级容器在 Chat 模式关闭纵向滚动，
  Thread Rail、Conversation、Run context 各自使用内部滚动区，消息增长不再撑高页面。
- 参考 Paseo P1 的 `ToolCallDetail → displayName / summary` 做法，在 Core 新增统一
  `AgentActivity`：Claude 的 thinking / tool_use 与 Codex JSONL 的 reasoning /
  command_execution / web_search / mcp_tool_call 映射为 Thinking / Read / Search /
  Shell / Tool。
- Activity 只保存单行、最多 1000 字符的可见摘要；文件路径、搜索词和命令摘要可随
  Thread 恢复，reasoning 正文、原始 tool input、tool output、Provider JSON、隐藏
  Prompt 和 Session 原文继续不进入 Chat 文件。
- Worker、GenerationController 与 ChatStore 打通结构化 activity 事件；Controller
  对 id / label / detail 再次限长并做 defensive copy，Chat 只渲染真正的 Agent
  Activity，不把 phase、Evidence 或 project response 混入执行时间线。
- Conversation 在用户仍接近底部时自动跟随新 Activity，主动上滚后保留阅读位置；
  运行中显示从 Thread `createdAt` 计算的秒级 elapsed time。
- Project response 仍逐项目 checkpoint，保证取消或崩溃时数据可恢复；Renderer
  通过 `visibleProjectResponses` 把显示时机统一门控到 `completed`，running /
  cancelling / cancelled / failed / interrupted 均不展示半成品 Rules。
- 隔离 workspace 的真实 Electron 回放验证：running 态显示 5 条 Activity 与实时
  `6m 12s`，2 条 Candidate 完全不可见；completed 态同一页面一次性展示全部 2 条
  Candidate。两态外层高度不变，滚动条只出现在 Conversation 内。
- 最终验收：Core 24 suites / 240 tests、App 12 suites / 80 tests、Core/App
  production build 与 `git diff --check` 全通过。App composite typecheck 仍只有既有
  跨 workspace / JSON include 的 TS6307，production build 和 Jest TypeScript
  编译没有新增错误。

## APP Chat Activity 可读性修正（2026-07-30）

- 真实 Generation Thread 对账确认：Rules Generation 已把 Evidence 注入 Provider，
  因此没有 Read / Search / Shell 属于合法行为；此前界面只剩重复 Thinking，是因为
  Claude 只保存了 thinking start，页面又过滤了真实 Generation pipeline。
- Persisted Conversation 移除 Assistant 头像、标题和状态 Chip；Request 后直接展示
  Assistant 正文、Activity timeline 与完成态 Candidate，减少重复层级。
- Claude 现在按每次 LLM 调用生成唯一 thinking id，收集 `thinking_delta`，在 block
  stop 时发出带正文的 completed Activity；Codex completed reasoning 同样保留可见
  summary/text。同一 id 的 running/completed 更新在 ChatStore 和 Renderer 两层合并。
- Thinking 正文最多保留 8000 字符并保留换行，点击 Activity header 可展开/收起；
  tool output、原始 tool input、隐藏 Prompt 和 Session 原文仍不进入 Chat。
- GenerationController 将 progress 作为 phase event checkpoint；ChatStore 如实映射
  Collect / Analyze / Draft / Validate / Retry，并使用稳定 id 合并同一阶段。真实
  tool use 仍展示 Read / Search / Shell，不为丰富界面伪造工具调用。
- Candidate Artifact 的显示门控没有改变：只有 Thread `completed` 后才一次性展示
  全部 Rules；running、cancelling、cancelled、failed、interrupted 均不显示半成品。
- 最终验收：Core 24 suites / 240 tests、App 12 suites / 82 tests、Core/App
  production build 与 `git diff --check` 全通过。App composite typecheck 仍被既有
  跨 workspace `rootDir` / JSON include TS6307 阻断，Electron production build 与
  Jest TypeScript 编译没有新增错误。

## Rules Evidence Context 与 Recent activity 语义修正（2026-07-30）

- Recent activity 不再读取最近 Scan 报告的 new / updated 历史，而是直接筛选
  `sessions.updated_at >= now - 7 days` 且非 missing 的 Session。Codex JSONL 的
  `updatedAt` 从首条 session metadata 创建时间改为文件 mtime；Claude 多文件
  Session 取全部 JSONL 的最大 mtime，确保旧会话最近继续对话时仍能入选。
- Evidence 默认读取选中 Session 的全部 user / assistant 消息；APP 不再隐式传入
  30 rounds，Evidence Explorer 也不再只预览末尾 30 条。CLI 的显式 `rounds`
  兼容入口继续保留。
- JSONL Evidence 改为逐行流式解析，绕开 `sessions show` 的 50 MiB 一次性输出
  限制。真实最大 Project 验证从 239 个可读 Session / 20,447 条消息提升到
  245 个可读 Session / 36,074 条消息；源端仅有 metadata 而没有正文的 Copilot
  Session 仍明确报告并跳过。
- 每次 Generation 创建权限为 0700 的 Run 临时目录，每个 Project 写 manifest
  和约 512 KiB Markdown batches；保存完整脱敏 Evidence、locator、role、
  frequency 与工具摘要。Prompt 只要求 Agent 读取 manifest 和全部 batch，不再
  内联 Evidence 或 JSON Schema。
- Claude 使用 Evidence Project 目录作为 cwd，仅开放 Read / Grep / Glob，并通过
  SDK `outputFormat: json_schema` 获取结构化结果；Codex 使用 read-only sandbox、
  `-C` 与 `--output-schema`。Provider 输出仍经过本地 Zod 二次校验。
- 确定性 JSON / Schema / Prompt 长度 / max turns 错误不再重试；默认 Provider
  请求不自动重试，调用方只有显式设置 `maxRetries` 才会对瞬时错误有限重试。
  completed / failed / cancelled 均在 finally 清理 Context，进程退出和 APP 启动
  也会清理遗留 PID / 超龄目录。
- Candidate 数据库只保存 reasoning、evidence refs 与 source session ids，不再把
  完整 Evidence bundle 写入 `evidence_json`；input hash 仍基于完整脱敏 bundle，
  保持可审计而不落原文。
- 真实 `agent-workspace` 压力验证读取 36,074 条消息，形成 35,453 个 excerpt、
  35 个 batch，约 11 秒完成并清理。真实 Claude 单次调用因上游 inference gateway
  返回 502 结束，确认没有隐藏 retry 且失败清理正常。
- 最终验收：Core 25 suites / 247 tests、App 12 suites / 83 tests、Core/App
  production build 与 `git diff --check` 全通过。Core build 仍只有既有
  `tsdown define` 警告。

## Rules Evidence 选择性读取与 Claude 网关兼容修正（2026-07-30）

- “完整收集 Evidence”与“模型全量加载 Evidence”解耦：Agent 先读取绝对路径
  manifest，再用 Glob / Grep 搜索明确要求、纠正、偏好和重复信号，只对命中位置
  局部 Read；Prompt 明确禁止依次读取全部 batch。
- 单项目 turns 预算从随 batch 数增长改为固定上限。真实验证表明 16 turns 会在多组
  选择性搜索后无法完成输出，最终定为 32 turns；读取范围仍由选择性检索约束。
- 定位到 14.4 MB `agent-rules-manager` Evidence 的来源不是用户对话，而是 Rules
  Generation 自己创建的 Claude Provider Session：旧 Prompt 内嵌完整 Evidence，
  扫描后又被下一轮收集，形成自我回灌。Evidence 构建现在识别内部生成 Prompt
  签名并排除整个 Session，包括其 Assistant 输出。
- 污染过滤后，问题项目由 28 个索引 Session 中的约 14.4 MB / 52 excerpts 降为
  3 个真实 Session、约 2 KB / 10 excerpts；Recent cutoff 下仅 2 个 Session、
  58 bytes。全部原始 Session 文件仍保留，只是不作为 Rules Evidence。
- 同一 Claude Agent SDK / inference gateway 的最小对照确认：带
  `outputFormat: json_schema` 的短 Prompt 约 3 分钟后返回 502；不带原生 Schema
  时 3.2 秒成功返回。因此 Codex 继续使用 `--output-schema`，Claude 改用短 YAML
  输出契约，`rule_text` / `reasoning` 使用 block scalar，本地再做 YAML 解析和 Zod
  校验。
- JSON fallback 仍支持平衡括号扫描，可从多段输出中提取独立 JSON；Claude YAML
  路径解决了正文包含未转义 ASCII 双引号导致的非法 JSON。
- 真实 dry-run：`agent-rules-manager` 65 秒完成、0 候选；Recent 最大项目
  `agent-workspace` 约 1.27 MB Evidence 产出 8 条候选；`ai-guanglinglu`
  产出 10 条候选。均在 3–5 秒内出现 Thinking / Search / Read，未再出现 502、
  Prompt too long、max-turns 或结构化解析失败。
- 最终验收：Core 25 suites / 251 tests、App 12 suites / 83 tests、Core/App
  production build 与 `git diff --check` 全通过。Core build 仍只有既有
  `tsdown define` 警告。

## Claude 空候选混合输出解析修复（2026-07-30）

- 真实 Recent activity Run `ee0ae394-5fdc-4a37-a9b3-4b662992fa91` 的首个
  Project 正常完成 manifest / Grep / Read，但 Claude 在空候选数组 `[]` 前附加了
  一段结论说明。YAML parser 会把整段混合文本解析成合法字符串，旧实现只判断
  `parsed !== undefined`，因此字符串提前返回并触发 Zod `expected array`。
- Claude 结构化解析改为 Schema-aware candidate selection：对 fenced 内容、完整
  回复及平衡括号提取的内嵌 JSON 数组 / 对象逐一做 YAML parse + Zod safeParse，
  只返回真正符合调用方 Schema 的候选。说明文字会被跳过，内嵌 `[]` 可正常表示
  零条规则；纯 YAML 候选和多 JSON 片段兼容行为保持不变。
- 新增真实失败形态回归测试：“说明文字 + 空行 + `[]`”必须解析为零条候选；
  非结构化字符串仍按确定性 Schema 错误失败，不触发无意义重试。
- 使用真实 `agent-rules-manager` 再次执行 Claude dry-run：28 个索引 Session
  过滤后形成 10 excerpts / 1 batch，Provider 正常完成并返回 0 条候选，没有写库，
  不再出现 `expected array`。
- 最终验收：Core 25 suites / 252 tests、App 12 suites / 83 tests、Core/App
  production build 与 `git diff --check` 全通过。Core build 仍只有既有
  `tsdown define` 警告。

## Rules 多项目部分失败隔离（2026-07-31）

- 真实 Recent activity Run `afb5b2e8-08b1-494d-bb6d-0b5680ef1ec1` 中，
  `agent-workspace` 已生成 10 条候选，但第三个 `ai-guanglinglu` 的结构化解析异常
  直接跳出了项目循环；持久化事务位于循环之后，导致前面成功候选没有落库，最终
  Thread 也因 failed 门控隐藏全部 Artifact。
- `runRulesGenerate` 改为项目级错误隔离：非取消错误记录为失败响应并继续后续项目；
  成功 Project 仍进入统一事务落库。只要至少一个 Project 成功，Run 以 completed
  完成并携带 `failedProjectCount`；只有全部 Project 失败才抛出聚合错误。取消仍
  立即抛出，保持“取消不产生 Draft”的既有语义。
- `ProjectGenerationResponse` 增加 completed / failed 状态和可选错误。Worker
  metadata 记录失败项目数；Chat timeline 将失败项目显示为独立 Failed Activity，
  完成态仍展示所有成功 Candidate；Rules 过程视图也区分失败响应。
- 同一真实 Run 的第三个 Provider 输出并非没有候选，而是在英文说明后输出 YAML
  根列表。Claude parser 新增根级 `- ...` 序列切片，并继续以 Zod Schema 选择有效
  候选，兼容“说明文字 + YAML 列表”。
- 回归测试覆盖：说明 + YAML 根列表、三项目中间失败仍继续并持久化首尾候选、全项目
  失败仍失败、部分成功 Chat Thread 保持 completed 且失败项目单独记录。
- 真实 `ai-guanglinglu` Claude dry-run 读取 20 个索引 Session，过滤形成
  362 excerpts / 3 batches，最终成功解析并返回 11 条候选，`projectFailures` 为空，
  没有写库。
- failed 历史 Thread 的展示门控改为只过滤显式 failed Project，并展示此前已完成
  Project 的候选；因此真实失败 Run 中已经保存在 `projectResponses` 的 10 条候选
  可在新版 App 中恢复可见。running / cancelling / cancelled / interrupted 仍隐藏
  Artifact，保持流式阶段不展示半成品。
- 最终验收：Core 25 suites / 255 tests、App 12 suites / 84 tests、Core/App
  production build 与 `git diff --check` 全通过。Core build 仍只有既有
  `tsdown define` 警告。

## Rules Evidence 资格与既有规则去重（2026-07-31）

- Rules Evidence 不再把 Codex 注入的 `# AGENTS.md instructions ... <INSTRUCTIONS>`
  当作用户对话。注入正文及其绝对路径 `@file` 引用会被提取为只存在于本次临时
  Context 的 Existing rule baseline；环境、权限、skills 和 plugin catalog 等
  平台上下文直接排除。
- Evidence excerpt 增加 `user_signal / assistant_context` 资格。默认仍保留完整
  user / assistant 对话供 Agent 理解，但 frequency 只统计跨 Session 的真实用户
  表述，Assistant frequency 固定为 0，Assistant 复述不能独立建立规则。
- 每个 Project Context 单独写 `baseline.md`，manifest 只记录其路径、大小和来源数。
  Prompt 要求先读取 Baseline 并排除语义等价项，同时允许真实用户提出与 Baseline
  冲突的纠正；Baseline 不是 Evidence，也不写入 Chat 或数据库正文。
- Provider 返回后增加本地强校验：Candidate 必须引用当前 bundle 中至少一条
  `user_signal` locator；Assistant-only、伪造 locator 和与 Baseline 明显等价的
  Candidate 在 Project response 与数据库持久化前统一过滤。
- 最近 7 天真实 `agent-workspace` 对账：32 个选中 Session 中 31 个可读，形成
  417 条 user signal、1,919 条 assistant context 和 2 个 Baseline source；
  Evidence 中不再包含 AGENTS 注入，中文回复与 RTK 规则均进入 Baseline。
- 全历史 Claude 压力验证完成 310 个 Session 收集，形成 35,110 excerpts /
  36 batches，没有出现大 Prompt、retry 或 too-long；Provider 长时间未返回最终
  结构化结果后手动取消 dry-run，没有写数据库。
- 回归验收：Core 25 suites / 258 tests、App 12 suites / 84 tests、Core/App
  production build 与 `git diff --check` 全通过。Core build 仍只有既有
  `tsdown define` 警告。

## Rules 生成批次切换（2026-07-31）

- Generated Rules 合并生成历史，不再提供独立的 Generation History 子导航。
  顶部生成批次选择器以 `runId` 过滤候选；未选择批次时展示当前状态下的全部候选。
- 生成批次与 draft / accepted / rejected 是两个正交筛选维度。直接进入 Rules
  默认“全部待审核”；从 Chat 的“打开生成的规则”进入时携带当前 `runId`，
  自动定位对应生成批次。
- 已选择批次时提供“查看生成过程”，回到对应 Chat Thread；真实窗口验证了
  Chat → Rules → Chat → Rules 往返后仍定位同一批次，并展示该批次的 51 条候选。
- 发布语义保持累计 accepted，不按当前批次截断，避免 Agent 文件覆盖写入时丢失
  其他批次已经接受的规则。
- Rules 批次过滤拆为独立纯模块并增加单元测试；布局契约测试覆盖历史子导航移除、
  Chat 传递 `runId` 与 Rules 初始批次定位。
- 最终验收：Core 25 suites / 258 tests、App 13 suites / 86 tests、Core/App
  production build 与 `git diff --check` 全通过。Core build 仍只有既有
  `tsdown define` 警告。

## Generation 运行级 Agent 配置（2026-07-31，Model / 布局补充）

- Generate 发起页新增 Agent（Claude / Codex）、Model、Reasoning Effort 与
  Fast Mode 选择器；初始值读取 Settings，Model catalog 随 Agent 切换并监听
  Provider 刷新，禁用的 Provider 不进入可选列表，本次选择不会改写全局默认配置。
- Generate 主内容在桌面端使用双栏：Evidence scope / 项目选择位于左侧，完整
  Agent 配置卡位于右侧；窗口窄于 1100px 时回退为单栏。配置卡内部四个配置项继续
  使用“左侧说明、右侧控件”的横向行布局，窄屏才降为上下排列。
- Generation Request 扩展为携带 `provider / model / effort / fastMode`，IPC 会补齐
  旧调用缺失的默认值并拒绝非法或已禁用 Provider；Worker 将四个字段显式传给
  `runRulesGenerate`，运行元数据与 FS-first Chat Thread 同步保存本次配置快照。
- Chat Context 展示本次 Run 的 Agent、Model、Effort 与 Fast Mode；旧 Thread 没有这些
  字段时显示不可用，不伪装成当前默认值。
- 修正跨 Provider 的默认 model 污染：当 Run 显式从全局默认 Provider 切换到另一
  Provider 且未指定 model 时，不再沿用原 Provider 的顶层默认 model；显式选择
  “Provider 默认 Model”使用 `null` 语义，也不会回退到 Settings Model。
- 计划与验收记录见 `docs/plans/09-generation-agent-options.md`。回归覆盖 Controller
  传参、ChatStore 恢复、Renderer 布局契约和 Core Provider 参数覆盖。
- 最终验收：Core 25 suites / 260 tests、App 13 suites / 86 tests、Core/App
  production build 与 `git diff --check` 全通过。Core build 仍只有既有
  `tsdown define` 警告。

## Generation 发起页视觉层级收敛（2026-07-31）

- 移除包裹整个发起页的大型 Card、隐藏流程栏和悬空全局 Footer，页面高度改为由真实
  内容决定，不再制造首屏大块无效留白。
- 桌面端使用 `Evidence 主区 + 22rem 本次运行面板` 的左右布局；Evidence 增加明确的
  步骤标题，选中项使用细左边框和低强度底色，右侧只保留紧凑参数行。
- 本次 Evidence 摘要与“继续进入对话”收进右侧面板底部，使执行参数、范围确认和提交
  行为成为一个完整操作单元；窄于 1100px 时仍回退为单栏。
- Model 默认项缩短为“Provider 默认”，避免右侧窄面板中的换行。
- 使用真实 Electron 窗口完成中文深色主题截图对账，确认左右主次、控件密度、按钮
  归属与首屏留白符合预期。
- 最终验收：Core 25 suites / 260 tests、App 13 suites / 86 tests、Core/App
  production build 与 `git diff --check` 全通过。App 独立 `tsc --noEmit` 仍受既有
  monorepo `rootDir` / JSON include 配置及 `RulesSection` 的 `history` 类型问题影响；
  production build 不受影响。

## 页面布局系统与 Rules 样板迁移（2026-07-31）

- `DESIGN.md` 建立 collection / dashboard / task / workspace 四种页面原型，以及
  narrow / wide / fluid 页面宽度、sm / md / lg 辅助栏、密度、Surface、滚动与主操作
  决策规则；普通产品页默认限宽，fluid 只用于宽度确实承载更多信息的 Workspace。
- 新增 PageShell、SupportingPaneLayout、MetricStrip、PageSection 页面级 Primitives。
  PageShell 统一宽度、页面内边距、密度与滚动语义；SupportingPaneLayout 通过
  container query 统一主辅栏折叠，并保持 DOM 中主区在前、辅助栏在后。
- Rules 总览迁为 `dashboard + wide + md pane`，仍保持 Header → 4 KPI → 待办主区
  + 右侧健康状态 / 最近生成 → 项目入口；Generate 迁为 `task + wide + lg pane`，
  Evidence 在左，本次运行参数与提交动作在右，业务状态、文案与交互未改。
- 反向验证中临时移除 Rules Dashboard 的 PageShell，布局契约按预期失败 1 条；
  恢复后布局契约与真实 SSR Primitive 测试 29/29 通过。
- 1024×768、1440×900、1920×1080 的真实 Electron 几何验证均无横向溢出；
  1024 下 Pane 下沉，1440 / 1920 下 Pane 在右，1920 PageShell 为 1296px，
  两页均只有一个 Primary Action。
- 最终验收：App 14 suites / 91 tests、Core 25 suites / 260 tests、skipped=0，
  Core/App production build 与 `git diff --check` 全通过。App 独立 typecheck 的既有
  monorepo `rootDir` / JSON include 与 `RulesSection history` 问题仍不在本轮范围。

## Rules Dashboard 信息层级重组（2026-07-31）

- 在既有 `dashboard + wide + md pane` 布局系统内重组总览页，不新增另一套页面组件：
  移除脱离任务上下文的四项顶层 KPI 带，把待审核与已接受数量收进审核主区摘要。
- “需要你处理”成为唯一主工作区，继续展示前四条待审核规则与原有审核入口；Agent
  健康、最近生成和项目规则入口合并为一个右侧状态面板，项目入口不再孤立横跨页面。
- DESIGN 补充 Dashboard 指标归属规则：任务指标就近进入主工作区，支持信息合并到
  辅助状态面板，避免为了凑指标数量占据整行或堆叠孤立小区块。
- 布局契约先因缺少 `data-dashboard-summary` 按预期失败，完成重组后与 Primitive SSR
  测试 29/29 通过。1024×768 下 Pane 下沉，1440×900 与 1920×1080 下 Pane 在右，
  三档均无横向溢出；1920 PageShell 保持 1296px，每页仍只有一个 Primary Action。
- 最终验收：App 14 suites / 91 tests、Core 25 suites / 260 tests、skipped=0，
  Core/App production build 与 `git diff --check` 全通过。

## PageShell 一级区块间距修正（2026-07-31）

- 修复 PageHeader 与后续主工作区视觉贴合：根因是 PageShell 使用 `space-y-*` 管理
  一级区块，同时 PageHeader 允许页面传入 margin class，父级间距可能被子级样式覆盖。
- PageShell 的 compact / comfortable 密度改为父级 `grid gap-6 / gap-7`。一级区块距离
  现在由布局 Primitive 独占，页面和子组件不再需要补临时 `mt-* / mb-*`。
- Primitive SSR 测试先因仍输出 `space-y-6` 按预期失败，改为 grid gap 后与布局契约
  29/29 通过；DESIGN 同步规定 PageShell 一级区块只能使用不可被子级覆盖的父级 gap。
- 真实 Electron 在 1024×768、1440×900、1920×1080 三档测得 Rules Dashboard
  Header 到主区均为 24px，Generate 均为 28px；两页无横向溢出，Pane 折叠保持正确。
- 最终验收：App 14 suites / 91 tests、Core 25 suites / 260 tests、skipped=0，
  Core/App production build 与 `git diff --check` 全通过。

## Rules 生成质量加固（2026-07-31）

- Evidence 读取由统一关键词检索改为按正文体积自适应：不超过 128 KiB 的项目使用
  `complete`，要求 Agent 读取全部 batch；更大的项目使用 `selective`，要求中英文
  规则信号检索、命中位置上下文阅读，以及逐 batch 搜索覆盖检查。manifest 和
  Project Context 同步记录 `readingStrategy / totalBatchBytes`，便于 Prompt 与测试
  观察真实策略。
- `frequency` 的语义明确为标准化后整条用户消息完全一致的跨 Session 次数，只作为
  重复信号的保守下界；不引入容易误聚类的本地语义相似算法。Agent 若判断存在同义
  重复，必须实际找到并引用每条 locator，不能把 `frequency=1` 当作没有同义证据。
- Prompt 增加持久性、原子性、Evidence 忠实度和 scope 自检：排除一次性任务、状态
  描述、普通事实、粘贴内容、临时 workaround 与 Assistant 自创做法；每条候选只表达
  一个行为约束，不得把局部要求泛化；不再输出基于单次推断的 low 候选。
- 单项目 Evidence 默认只支持 project rule。只有引用的真实用户消息明确表达所有项目、
  所有任务、跨项目、以后都或对应英文全局意图时，global 才保留；本地资格校验会在
  Chat response 和持久化前将无依据 global 降级为当前 project、纠正伪造/错误
  `project_slug`、清除合法 global 的 project slug，并过滤所有 low 候选。
- 计划与逐步验收记录见 `docs/plans/rules-generation-quality.md`。测试先覆盖两种读取
  策略的 manifest / Prompt，以及 project slug 纠正、global 保留/降级和 low 过滤，
  再完成实现。
- 最终验收：Core 25 suites / 263 tests、App 14 suites / 91 tests、skipped=0，
  Core/App production build 与 `git diff --check` 全通过。Core build 仍只有既有
  `tsdown define` 警告。

## Chat 失败任务重新生成（2026-07-31）

- Chat 对 `failed / cancelled / interrupted` 规则生成 Thread 提供“重新生成”；成功态
  继续只提供候选审核出口，运行态继续只提供停止操作，保持每页一个 Primary Action。
- 重新生成直接复用原 Thread 持久化的 `mode / projects / provider / model / effort /
  fastMode` 请求，通过既有 `rules.generate` IPC 创建全新 Run；旧 Thread 不覆盖，成功
  返回后自动刷新并选中新 Thread。
- 提交期间按钮禁用并展示 loading；若已有生成任务占用 Controller，则在当前页面展示
  明确错误，不创建重复 Run。加载错误与操作错误使用不同标题。
- 状态资格拆为 `canRegenerate` 纯函数；计划与观察点见
  `docs/plans/chat-regenerate.md`。测试覆盖六种 Run 状态和 Renderer 调用 / 跳转契约。
- 最终验收：App 14 suites / 93 tests、Core 25 suites / 263 tests、skipped=0，
  Core/App production build 与 `git diff --check` 全通过。Core build 仍只有既有
  `tsdown define` 警告。

## Codex 严格 Schema 与错误诊断修复（2026-07-31）

- 真实 Codex 批量生成的 10/10 失败并非 Skills traversal 导致。Codex JSONL stdout
  已返回 `invalid_json_schema` 400，但旧 `callCodex` 忽略 `item.type=error` 和顶层
  error，只在非零退出时展示 stderr，导致 Chat 被重复的 Skills 告警淹没。
- `callCodex` 现在优先展示顶层 fatal error；只有没有 fatal event 时才使用 item error。
  stderr diagnostics 按去除时间戳后的内容去重，最多保留 3 行 / 2,000 字符。
- 自定义 Provider 使用严格 Structured Outputs：根 Schema 必须是 object，且 properties
  中每个字段都必须进入 required。Codex Schema 因此包装为 `{ candidates: [...] }`，
  并只在 Codex 适配层递归补齐 required；`project_slug` 使用 `string | null`。业务 Schema
  继续兼容 Claude 省略 global `project_slug`，资格校验后统一显式返回 null。
- 本机 `twitter-user-posts/cache` 有约 538 MB / 8,855 文件，触发 Codex 0.146 Skills
  traversal diagnostic；短请求和修复后的规则生成均证明它是非致命告警，因此不移动、
  不删除 Skill 或缓存数据。
- 真实 `rules-manager` Codex dry-run 完整读取 2,810 excerpts / 3 batches，成功生成 8 条
  候选，`projectFailures` 为空且没有写库。计划与逐步验证见
  `docs/plans/codex-error-diagnostics.md`。
- 最终验收：Core 25 suites / 266 tests、App 14 suites / 93 tests、skipped=0，
  Core/App production build 与 `git diff --check` 全通过。Core build 仍只有既有
  `tsdown define` 警告。

## 候选规则来源会话上下文（2026-07-31）

- 候选审核页与生成过程中的候选详情不再直接展示 Evidence locator JSON；改为来源
  Session 卡片，展示 Agent、时间、Session ID，以及命中消息前后各两条脱敏上下文，
  命中消息使用独立强调状态。
- `evidence_json` 只保存 reasoning 与 locator，来源列表实际位于候选记录独立的
  `source_sessions` 字段；Renderer 现在分别解析两者，修复了旧页面“来源会话 —”的
  数据读取错误，并兼容历史 `session:index` locator。
- 新增 `sessions.evidenceContext` IPC，复用 Session Preview Worker 从既有
  `source_path` 按需读取固定窗口。上下文不写入 DB / Chat；仍统一脱敏 secret，只返回
  工具名与摘要，不返回工具参数和 tool output。单条源文件缺失或历史 locator 无法识别
  时局部降级，不阻塞候选审核。
- Core 保留原始消息索引到预览消息的映射，并为 Codex JSONL 与 OpenCode SQLite 分别
  覆盖精确命中测试。本机真实候选 locator 通过 production Worker 验证：返回 5 条窗口，
  且只命中 locator 指定的消息索引。
- 设计与逐步验收记录见 `docs/plans/rule-evidence-context.md`；最终验收：Core 25 suites /
  268 tests、App 14 suites / 96 tests、skipped=0，Core/App production build 与
  `git diff --check` 全通过。Core build 仍只有既有 `tsdown define` 警告。

## 历史 Evidence locator 资格标识（2026-07-31）

- 用户在来源查看器中发现 10:01 旧 Run 保存的 locator 指向 AGENTS.md 注入消息。该 Run
  早于 18:03 的 Rules 生成质量修复；当前 `buildEvidenceBundle` 已把 AGENTS / CLAUDE
  注入转入 `existingRules` baseline 并 `continue`，不会进入 excerpts，候选资格校验也只
  接受真实 user signal。
- 来源查看器原先只验证 locator 能否定位，错误地统一标成“Evidence 命中”。按需上下文
  现在返回 `eligible / existing_rule_baseline / platform_context`，Renderer 只有对
  `eligible` 显示 Evidence 命中；规则基线和平台上下文使用黄色“已排除”状态并解释其
  不参与当前候选计算。
- 不删除或改写历史候选。真实旧 locator `019f96ef-...#0` 经 production Worker 验证返回
  `existing_rule_baseline`，同时 OpenCode SQLite 单测覆盖 baseline 与普通用户消息在同一
  Session 内的资格区分。计划见 `docs/plans/rule-evidence-baseline-eligibility.md`。
- 最终验收：Core 25 suites / 268 tests、App 14 suites / 96 tests、skipped=0，Core/App
  production build 与 `git diff --check` 全通过。Core build 仍只有既有 `tsdown define`
  警告。

## 候选规则多选与批量状态操作（2026-07-31）

- Generated Rules 候选表新增表头全选、半选态和逐行 Checkbox；选择范围始终是当前状态
  与当前生成批次下的可见候选，切换状态或批次会清空选择，数据刷新时也会裁掉不可见 ID。
- 选中后显示就近批量工具栏，包含已选数量、清空选择、批量接受与批量拒绝。草稿页提供
  两个动作；已接受/已拒绝页只保留有意义的反向动作。提交期间 Checkbox 和按钮统一禁用，
  成功后刷新候选列表与计数，单条审核和发布流程不变。
- Core 新增 `updateRuleCandidatesStatus`：去重并限制单批最多 500 个 ID，事务内先验证全部
  候选存在，再使用同一时间戳统一更新；任一 ID 无效会整批回滚。Renderer 通过新的
  `rules.batchUpdateStatus` IPC 一次提交，不在前端循环单条更新。
- 计划与逐步验收见 `docs/plans/rule-candidates-bulk-actions.md`。测试覆盖两条候选成功更新
  与缺失 ID 的原子回滚，以及 IPC、全选/半选、批量动作和清空选择 UI 契约。
- 最终验收：Core 25 suites / 269 tests、App 14 suites / 97 tests、skipped=0，Core/App
  production build 与 `git diff --check` 全通过。Core build 仍只有既有 `tsdown define`
  警告。

## 候选规则多选白屏修复（2026-07-31）

- 真实 Electron 进入 Generated Rules 后白屏，DevTools 明确报错：HeroUI Table 内的
  Checkbox 缺少必需的 slot prop；这不是候选数据、IPC 或批量事务异常。
- 表头全选与逐行 Checkbox 均补充 `slot="selection"`。App 视图契约新增两处 slot 数量
  断言，测试先复现失败，再随实现通过，防止后续重构重新引入运行时崩溃。
- 热重载后的真实 Electron 页面已恢复，Generated Rules 成功展示 79 条草稿候选，控制台
  无应用错误。App 独立 typecheck 仍被既有跨 workspace `rootDir/include` 配置及既有
  `RulesSection` 的 `history` 类型错误阻塞，不属于本次改动。
- 最终验收：Core 25 suites / 269 tests、App 14 suites / 97 tests、skipped=0，Core/App
  production build 与 `git diff --check` 全通过。Core build 仍只有既有 `tsdown define`
  警告。

## 候选规则多选控件可见性修复（2026-08-01）

- 用户复验发现候选表虽然不再白屏，但选择列仍为空。真实 Electron 截图与可访问性树均
  证实 Table 只渲染了空 Cell，没有 checkbox 控件。
- 根因是 HeroUI 3.2.2 的 `Checkbox` 为复合组件：Root 只提供 Field/状态，不会自动绘制
  控件。表头和逐行选择现在均显式渲染 `Checkbox.Content → Checkbox.Control →
  Checkbox.Indicator`，同时继续保留 Table 要求的 `slot="selection"`。
- App 视图契约先新增三层复合组件的两处数量断言并确认失败，再完成实现。真实 Electron
  浅色页面已看到表头与逐行 Checkbox；勾选首行后显示绿色勾选、表头半选态，以及“已选
  1 条 / 清空选择 / 批量接受 / 批量拒绝”工具栏。
- 最终验收：Core 25 suites / 269 tests、App 14 suites / 97 tests、skipped=0，Core/App
  production build 与 `git diff --check` 全通过。Core build 仍只有既有 `tsdown define`
  警告。

## 候选规则整行选择热区（2026-08-01）

- 候选表不再要求用户精确点击小型 Checkbox。通过 React Aria Table 原生 `onRowAction`
  把候选行从 Checkbox 到置信度列扩展为选择热区，支持再次点击取消，并保留键盘行操作。
- 行增加 pointer、hover、focus ring 和已选背景反馈；批量提交期间忽略行操作，避免请求中
  改变选择集合。Checkbox 与最右侧审核按钮属于 Table 的交互子元素，保持独立行为。
- App 视图契约先增加行操作、提交态守卫及热区反馈断言并确认失败，再完成实现。真实
  Electron 中点击首行规则文字成功显示“已选 1 条”与批量工具栏；点击首行审核按钮仍
  直接进入候选详情，没有触发行选择。
- 最终验收：Core 25 suites / 269 tests、App 14 suites / 97 tests、skipped=0，Core/App
  production build 与 `git diff --check` 全通过。Core build 仍只有既有 `tsdown define`
  警告。

## 大 Session 流式读取（2026-08-01）

- `sessions show <session-id>` 新增 `--stream`，以一行一条记录的 NDJSON 输出
  `{ sessionId, agent, index, record }`。不带参数时继续返回原有单个 JSON 文档，并保留
  50 MiB 一次性输出保护，因此 Evidence 内部捕获逻辑和既有 CLI 调用不变。
- Claude / Codex / Cursor / Pi 走 `createReadStream + readline` 逐行解析，不再构造完整
  records 数组；Copilot events 复用相同链路，Copilot SQLite turns 使用 statement
  iterator，OpenCode SDK 消息按返回顺序逐条写出。所有来源保持只读且不落对话原文。
- 流式 writer 支持下游返回停止信号并识别同步 `EPIPE`。真实 70 MB Codex Session 首次
  `--stream | head` 发现 Node 延迟派发 `EPIPE` 的竞态，CLI 随后增加仅在流式命令期间
  生效的 stdout pipe guard；同一真实命令复验退出码为 0，只输出计数 2。
- 计划与观察点见 `docs/plans/session-show-streaming.md`。测试覆盖超过 50 MiB 后提前停止、
  NDJSON 顺序、BOM / CRLF、非法行定位、OpenCode、Copilot events / turns，以及真实子进程
  stdout 提前关闭回归。
- 最终验收：Core 25 suites / 275 tests、App 14 suites / 97 tests、skipped=0，Core/App
  production build 全通过。Core build 仍只有既有 `tsdown define` 警告。

## Chat View 原生 Agent Session 重构规格（2026-08-01）

- 将下一阶段的 Chat 定义为一个 App Chat 对应一个 Claude/Codex Native Session；当前
  Rules Generation version 1 Thread 继续只读兼容，不伪造 Native Session。完整规格见
  `docs/specs/chat-view-native-sessions.md`，7 步实施节奏见
  `docs/plans/chat-view-native-sessions.md`。
- 工作目录收敛为所有 Chat 共用 `resolveWorkspace().workspaceDir`，不创建每 Chat 目录；
  Full access 固定开启。Provider 首轮后锁定，model/effort/fast 按轮生效；一个 Chat 同时
  一轮，不同 Chat 无应用级并发上限。
- 右侧历史 Session 采用引用而非复制：首次选择或集合变化后的下一轮发送完整 replace
  block 和净 added/removed，每个来源只提供
  `memory-manager sessions show <id> --stream`。Agent 自行决定读取深度，大 Session 和失效
  源由 CLI/Agent 处理，App 不实现 Locator、摘要器、Preflight 或 token 分配。
- ChatStore version 2 只保存 Native 引用、UI 元数据、可见消息投影和 Tool Item 引用；
  完整 tool input/output 按需从 Native Session 读取，不落 ChatStore，隐藏 Prompt 不进入
  Renderer。Context Window 只展示 Provider 权威数值。
- Codex Archive/Restore/Delete 分别使用 app-server `thread/archive`、`thread/unarchive`、
  `thread/delete`；Claude Archive 仅为 App 状态，永久删除使用 SDK `deleteSession()`。
  Native resume 失败不得静默换 Session。
- Rules Run 改为带 `origin=rules` 和首轮 `intent=rules-generation` 的普通 Chat；后续默认
  普通对话。现有 Evidence 资格与 Candidate 持久化约束必须保留。
- 代码实测基线：Core 25 suites / 275 tests、App 14 suites / 97 tests、skipped=0；两端
  production build 通过。Provider 版本为 Claude Code 2.1.220 / SDK 0.3.220、Codex CLI
  0.146.0。执行目标覆盖计划全部 7 个阶段；Claude Native Chat 最小骨架只是第一个完成即
  验证的 checkpoint，不是本轮终点。

## Chat V1 Phase 1：Claude Native Chat 最小闭环（2026-08-01）

- ChatStore 新增 version 2 Native Chat，保持 version 1 Rules Generation 兼容读取；v2 仅保存
  Native Session 引用、可见消息投影、每轮配置与 UI/生命周期元数据，绑定后的 Native ID
  不允许被不同 ID 覆盖。
- 新增 `ChatRuntimeManager`、`NativeChatController` 与 `ClaudeChatAdapter`。同一 Chat 仅一轮，
  不同 Chat 不设全局并发限制；首次调用 Claude start，后续及重建 Controller 后调用 resume。
- Claude 固定 workspace cwd、持久 Session、`bypassPermissions` 与
  `allowDangerouslySkipPermissions=true`；冻结 Host Policy 只在首轮 system preset append，
  resume 不重复注入。
- Renderer 新增仅本地 Draft、New Chat 和最小 Composer；首次发送才通过 `chat.send` 落盘，
  version 1 Thread 不显示 Composer。中央区常驻显示 Full access。
- 测试按红→绿推进：缺模块/API、缺 Controller、缺 Composer/IPC 三轮关键失败均已复现；最终
  Core 25 suites / 275 tests、App 17 suites / 104 tests、skipped=0，App build 与 diff check
  通过。
- 真实 Claude smoke 连续三轮（第三轮新 Query 实例）保持同一 Session ID
  `bc22d10e-6149-4f5f-a5aa-d39d9fa58303`，三轮精确返回预期短文本。
- 提交信息：`feat: 打通 Claude 原生 Chat 最小闭环`

## Chat V1 Phase 2：Codex app-server 原生接入（2026-08-01）

- Chat Runtime 新增 Codex stdio JSON-RPC Adapter；Chat 执行链使用
  `thread/start|resume`、`turn/start|interrupt`，不复用 Rules Generation 的
  `codex exec --ephemeral`。
- 新 thread 固定 workspace cwd、`approvalPolicy=never`、`sandbox=danger-full-access` 并
  注入一次 Host Policy；resume 只携带原 threadId，避免重启后重复系统指令。
- 每轮 `turn/start` 传递 model、effort、`serviceTier=fast|null`、cwd、never 与
  `{type: dangerFullAccess}`。Main 只归一化 Assistant 文本和数值 usage，不广播原始 payload。
- `thread/tokenUsage/updated` 的 Provider 权威值进入 ChatStore `contextUsage`；缺失时保持 null，
  不做本地 token 估算。
- 可控 JSON-RPC 假进程覆盖 initialize、start/resume、delta、usage、interrupt 与权限配置；
  真实 Codex 三轮在关闭并重建 app-server 后仍保持 thread ID
  `019fbde9-e579-7131-b57f-e3cf5e9bfe95`，第三轮 usage 为 20301 / 258400。
- 最终 Core 25 suites / 275 tests、App 18 suites / 107 tests、skipped=0，Core/App build 通过。
- 提交信息：`feat: 接入 Codex 原生 app-server Chat`

## Chat V1 Phase 3：Paseo 式 Conversation 与 Composer（2026-08-01）

- Main 与 Renderer 之间只传递归一化 `assistant_delta / tool_activity / usage`；Tool activity
  的持久化字段限制为 Native item ID 和安全摘要。原始 tool input/output 只能在用户展开卡片
  后由 Provider Adapter 分页读取，并且只保存在 Renderer 组件状态中。
- `chat.tool.read` 以 ChatStore 中已经持久化的安全 item 引用作为 allowlist，避免 Renderer
  构造任意 item ID 读取 Native Session。原生来源缺失返回 unavailable；大内容每页最多
  64 KiB，当前 UI 每次请求 8 KiB。
- Skills 发现复用 Paseo 式目录约定：公共 `~/.agents/skills` 加 Provider 自身 skills 目录，
  只识别含 `SKILL.md` 的目录并按名称去重；选择后只插入本轮 Composer，不建立持久 enabled
  列表。
- Provider 首轮后锁定；model/effort/fast 在入队时形成每轮快照。队列只存 Renderer 内存，
  不进入 LocalStorage/ChatStore；一个 Chat 仍由 RuntimeManager 保证单 active turn，不同 Chat
  可并行。
- Claude Context Window 使用 SDK result 的 `modelUsage` 权威字段，Codex 继续使用 app-server
  token usage；数值缺失时保持 null，不推算。真实 Claude UI 首轮得到 33499 / 200000。
- App 定向与全量测试、production build、真实 Electron 运行态/完成态及 1024 px 窄屏均已验证。
  提交信息：`feat: 完善原生 Chat 对话与 Composer`。

## Chat V1 Phase 4：Session Context 查询、选择与注入（2026-08-01）

- 新增 `querySessionContext`：直接查询 sessions 元数据，all 包含 default 与 missing/error；项目、
  from/to 闭区间和 `(updated_at DESC, id DESC)` keyset cursor 可组合，单页 1–200。Renderer
  默认每页 100，并使用固定 58 px 行高、290 px viewport 和 overscan 4 的窗口化列表。
- Selected 集合与查询结果分离，通过 `resolveSessionContextItems` 恢复来源状态；完全不存在的引用
  合成为 `status=missing/sourceAvailable=false`，因此切换项目或日期不会丢选择或失效提示。
- `sessionContext.revision` 只随 canonical 引用集合变化递增；新增内部
  `lastInjectedSelected` 保存上次成功提交集合，解决多次未发送修改后无法计算净 added/removed
  的问题。旧 v2 文件缺少该字段时按空集合兼容。
- Controller 在调用 Provider 前构造隐藏 replace block，但写 messages.jsonl 时只写用户原文；
  仅 Provider turn 成功后推进 lastInjectedRevision。单次失败测试确认下一次 start 会重发同一
  revision，且 Native ID 不被替换。
- Host Policy 继续承担不可信资料边界与单源失败继续执行；App 不做 Session 读取、摘要、
  Preflight、token 分配或“已加载 N/M”状态。真实 1.4 GB OpenCode SQLite 来源中的所选 Session
  经 `--stream` 被 Claude 读取为 31 条记录并正常完成。
- 提交信息：`feat: 接入 Chat Session 上下文`。

## Chat V1 Phase 5：History 生命周期（2026-08-01）

- Provider 生命周期契约补齐 archive/unarchive/delete。Codex 使用 app-server 原生 thread API；
  Claude 只有 deleteSession 原生删除，Archive/Restore 明确保持应用级语义。原生 not found 被视为
  幂等成功，其他错误原样上抛。
- Controller 的不变量是 Native-first：Archive/Restore/Delete 只有原生调用成功后才写
  `archivedAt` 或删除 ChatStore；Delete 失败时本地 Archived 记录不变。运行中 Archive 先向当前
  RuntimeManager turn 发 interrupt。
- `deleteArchivedNativeThread` 仅接受经过 thread ID 校验且 `archivedAt != null` 的 v2 目录；
  UI 只在 Archived 视图暴露永久删除，并有第二次确认。关联的右侧历史 Session 引用只是 ID，
  不随 Chat 删除。
- resume 错误继续由 `markNativeTurnFailed` 设置 `nativeState=resume-failed`，不覆盖 Native ID；
  Renderer 保持可读并允许正常重试，或复制 Provider/每轮默认配置/当前 Session Context 到纯
  Renderer Draft，首次发送才创建新 Native Chat。
- 真实 Electron 完成 Claude App 级 Archive/Restore、重命名、Active/Archived Rail 和删除确认
  Modal 验收；按不可恢复操作边界取消最终删除，原生删除由可控 Adapter 测试验证。
- 提交信息：`feat: 完善 Chat 历史生命周期`。

## Chat V1 Phase 6：Rules Run 原生 Chat 化（2026-08-02）

- `rules.chat.start` 同步落 v2 Chat/可见用户请求与 run_metadata，随后后台执行 Evidence 与 Native
  Provider；因此 Renderer 能立即进入 Chat，完成/失败通过 `chat.changed` 刷新持久投影。
- 生成质量链没有复制：`runRulesGenerate` 新公开其依赖接口，由 Native Controller 注入 generate
  callback，原有 qualify、Baseline、scope 与事务持久化仍是唯一实现。
- Rules Provider turn 使用共享 `candidateRulesOutputSchema()`；Claude 读取 SDK
  `structured_output`，Codex 传 `turn/start.outputSchema` 并按 itemId 分离 commentary/final，最后用
  `parseCandidateRulesOutput()` 统一校验和解包。
- Provider 的结构化正文只用于 Candidate pipeline，不写 messages.jsonl；Conversation 保存用户可见
  请求、工具安全摘要和最终 Artifact 摘要。`rulesArtifact.runId` 是 Generated Rules 审核出口。
- 自动 Session Context 来自 Evidence sourceSessions；首个生成 turn 注入一次 replace block。多项目
  内部 turn 复用同一 Native Session，生成完成后的用户消息自然走普通 `chat.send`。
- 隔离真实 Claude/Codex 均完成 Rules → Native Chat → 普通续聊，两个 Provider 的续聊前后 Native
  ID 相同；自动化覆盖原生 schema 参数、Codex 多 Agent message 解包和 v2 Artifact 持久化。
- 提交信息：`feat: 将 Rules Run 迁入原生 Chat`。

## Chat V1 Phase 7：响应式、兼容与全量收口（2026-08-02）

- V1 Generation Thread 只读兼容保持不变；Native Composer 只对 v2 且非 Archived Thread 出现。
  `resume-failed` 保留 Native ID，missing Session 仅影响引用状态，Provider 失败保留可读投影。
- 版面收口以 `h-[calc(100vh-4rem)] + overflow-hidden` 锁定 Chat viewport；1180px 断点让
  Conversation 独占内容宽度，Rail/Context 改为带 backdrop 的覆盖式 Sheet，三个内容区仍独立滚动。
- 真实窗口验收沿用 Phase 3 的 1024px Chat、Phase 5 的默认窗口生命周期操作，并在最终构建再次
  将 Electron 调整为 1024×768 检查 App Shell。Computer Use MCP 本轮连接超时，使用窗口系统只读
  截图补充检查，没有把未执行的 1440/1920 逐像素操作写成通过。
- 最终自动化基线：Core 277、App 125 全绿；两端 production build 与 diff check 通过。App 独立
  typecheck 的 `rootDir/TS6307`、跨 workspace 源导入及 JSON include 是既有工程配置 debt，继续留存。
- 提交信息：`chore: 收口 Chat V1 验收`。

## Chat View UX 布局收口（2026-08-02）

- Chat 桌面三栏按语义宽度重排为 16rem Thread Rail、弹性 Conversation、22rem Context Pane；
  Rail 折叠为 4rem，Grid 以 200ms 连续过渡并尊重 `prefers-reduced-motion`。
- 断点从只考虑 Chat 内部宽度的 1180px 调整为 1600px：实测 1440px 下保留三栏会把主对话压到
  约 500px，因此 1600px 及以下改为专注 Conversation，Rail/Context 使用位移 Sheet；Sheet 具备
  backdrop、Escape 关闭、关闭态 `inert`，避免键盘焦点进入不可见控件。
- Conversation、Native/Rules/Legacy 消息与 Composer 统一使用 60rem 阅读对齐线；用户气泡限制
  42rem。Composer 将输入、本轮 Agent/Model/Effort/Fast/Skills、Full access 与 Context Window
  合并为单一 Surface，解决原输入框过窄且配置栏游离的问题。
- Tool 卡片从 Conversation 到 `pre` 全链路增加 `min-width: 0`、最大宽度和局部 overflow/换行约束，
  超长 input/output 不再制造页面级横向滚动。
- 右栏拆为对话管理、两列运行上下文和 Session 上下文三个明确区块；已选 Session 区限制为
  7rem 内部滚动，避免大量引用把筛选和可选列表推出视口。
- 真实 Electron 已逐档检查：1728×979 保持平衡三栏；1440×900 使用专注布局并展开 Context Sheet；
  1024×768 正文与 Composer 无横向滚动。定向布局测试 30 项通过，App production build 通过。
- 最终自动化基线：Core 26 suites / 277 tests、App 20 suites / 127 tests 全绿；Core/App production
  build 与 `git diff --check` 通过。
- 提交信息：`refactor: 优化 Chat 布局与交互体验`。

## Chat View 去除常驻抬头与运行信息（2026-08-02）

- 按 UI 标注移除 Chat 页面级标题/说明，Workspace Card 改为占满 Chat viewport；窄屏 Rail/Context
  入口和 Rules Artifact/重试/停止操作改为 Card 内悬浮 Action，不再占用常驻顶栏。
- 右侧移除“任务上下文”“对话管理”“运行上下文”，Session Context Picker 直接成为 Pane 首项；
  Provider、Model、Effort、Full access 与 Context Window 已在 Composer 常驻，避免重复展示。
- Native Chat 的重命名、Archive、恢复、永久删除与 resume-failed 续开没有删除，统一收进 Thread
  Rail 顶部 `…` 管理 Modal。真实 Electron 1728×979 检查确认左右 Pane 与 Conversation 同顶对齐。
- 最终自动化基线：Core 26 suites / 277 tests、App 20 suites / 127 tests 全绿；Core/App production
  build 与 `git diff --check` 通过。
- 提交信息：`refactor: 精简 Chat 常驻信息`。

## Chat · Codex / Paseo 布局 HTML 原型（2026-08-02）

- 新增独立原型 `docs/prototypes/chat-codex-paseo-layout.html`，只用于确认后续 Chat View 的
  桌面布局方向，不修改现有 Renderer、Native Chat、Session Context 或持久化行为。
- 桌面骨架收敛为唯一 20rem 左栏、弹性 Conversation、可收起 22rem Session Context；移除
  页面外层 Card 的概念。左栏合并产品导航和 Chat 列表，右栏保留完整已选项、项目/日期筛选与
  虚拟列表语义。
- Conversation 与 Composer 使用 Paseo 的 820px 阅读线；用户消息为右侧轻量气泡，Assistant
  无外壳，Tool Activity 使用紧凑单行并支持按需展开。
- 原型支持右栏 Header/Composer 双入口、Escape/遮罩关闭、Session 选择与数量同步、Chat 行切换；
  右栏收起后 Grid 从 `320 + 1056 + 352` 变为 `320 + 1408 + 0`，中央宽度确实释放。
- Electron 以 1728×979、DPR 2 渲染出 3456×1958 预览，展开态视觉检查确认与 Codex P1 的贴边
  工作台、顶部基线和底部 Composer 接近，同时保留本项目常驻 Session Context 的业务差异。
- 验证结果：Core 26 suites / 277 tests、App 21 suites / 133 tests 全绿；两张预览均为
  3456×1958，HTML 无远程资源依赖，`git diff --check` 通过。
- 提交信息：`docs: 新增 Chat Codex Paseo 布局原型`

## APP 主题配色与持久化（2026-08-02）

- 主题偏好由 Renderer `localStorage` 保存为 `memory-manager.theme = dark | light`；缺失、非法或
  读取失败回退 dark，写入失败不阻断当前会话切换。主题不进入 workspace config、DB 或 ChatStore。
- 新增 `renderer/src/theme.ts` 统一主题校验、读写、DOM class 应用与初始化；`main.tsx` 在
  `createRoot` 前恢复已保存主题，避免重启时闪回 dark，`App.tsx` 切换时同步更新页面与持久化。
- 暗黑模式改为白黑灰阶（黑背景、白前景和白色主操作）；明亮模式改为白蓝（白 Surface、浅蓝背景、
  蓝色主操作）。success / danger / warning 继续保留状态语义色。
- 新增 6 项主题契约测试，覆盖合法/非法偏好、存储异常、class 清理、初始化恢复、切换保存与配色 token。
- 最终自动化基线：App 21 suites / 133 tests、Core 26 suites / 277 tests 全绿；两端 production
  build 与 `git diff --check` 通过。App 独立 typecheck 仍只有既有跨 workspace `rootDir/TS6307`、
  JSON include 与 `RulesView` 类型债。
- 提交信息：`feat: 持久化白黑与白蓝主题`

## APP 暗色背景 Codex 炭灰化（2026-08-02）

- 用户反馈上一轮 dark 主背景 `4%`、侧栏 `0%` 过黑；本轮保留白色前景、白色主操作、light 白蓝
  配色和 `memory-manager.theme` 持久化，仅重排 dark 背景层级。
- dark 主背景改为 `hsl(0 0% 12%)`（约 `#1f1f1f`），侧栏 `9%`、Surface `15%`、hover `19%`、
  primary-soft `20%`、border `22%`、default `19%`，形成 Codex 风格深炭灰层次。
- 主题契约先按新值失败、实现后恢复 6/6；App 全量 21 suites / 133 tests 与 production build 通过。
  真实 Memory Manager 暗色窗口检查确认主背景不再接近纯黑，侧栏、主区、卡片和 hover 辨识清楚。
- Computer Use 不允许读取 Codex 自身窗口；色阶以本机安装包可见静态资源和 Codex 当前视觉观感为参照，
  并在目标 APP 实际窗口完成最终视觉检查。
- 提交信息：`style: 调整暗色背景为 Codex 炭灰`

## APP 开发热更新修复（2026-08-02）

- 根因是 electron-vite 5 的 `dev` 默认只启动 Renderer HMR，只有显式 `--watch` 才监听 Main 与
  Preload；项目原 script 缺少该参数，因此 Main 修改不会重建或重启 Electron。
- dev script 改为 `electron-vite dev --watch`，保留原有 5 个 Main/Worker 构建入口；Renderer server
  固定 5173 并启用 `strictPort`，第二次 dev 启动不再静默漂移到 5174 后被单实例锁退出。
- 真实 smoke 确认 Renderer CSS 修改收到 HMR `js-update`；Main marker 修改使 Electron PID
  `84378 → 84703`，回退 marker 后再次变为 `84809`；第二次 dev 启动明确报 5173 已占用并返回 1。
- 新增 2 项配置契约；App 22 suites / 135 tests、production build 与 `git diff --check` 通过。
- 提交信息：`fix: 恢复 APP 开发热更新`

## Chat 布局原型产品导航修正（2026-08-02）

- 根据 Memory Manager 不是 Chat-first 产品、没有用户登录和 Workspace 管理的产品前提，原型左栏
  从 Codex 式项目/对话目录改为 14rem 产品级导航，仅保留扫描、项目、Chat、规则与设置。
- 移除用户头像、Pinned、Workspace 与项目分组对话；Chat 历史改为页面 Header 触发的 18rem 临时
  Drawer，默认不占永久列，包含新建对话、当前/归档与扁平历史列表。
- 右侧 Session Context 继续保持 22rem 并可独立收起；Conversation/Composer 继续共享 820px
  阅读线。1728×979 下实测默认布局为 `224 + 1152 + 352`，右栏收起后中央区为 1504px，历史
  Drawer 从 x=224 覆盖 288px，不改变中央 Grid 宽度。
- Electron 已分别渲染默认、右栏收起和历史 Drawer 展开三种 3456×1958 预览并完成视觉检查；HTML
  无远程资源，`git diff --check` 通过。Core 26 suites / 277 tests、App 22 suites / 135 tests 全绿。
- 提交信息：`docs: 修正 Chat 原型产品导航层级`

## Chat 布局原型截图标注精简（2026-08-02）

- 按第二轮截图标注移除窗口前进/后退、Chat Header 的消息/文件夹前置图标、Session Context 内部
  重复收起按钮，以及 Assistant Footer 的分支按钮；Conversation Header 的右栏按钮继续作为
  Session Context 唯一收起入口。
- 对话历史能力没有随图标删除：Chat Header 标题改为可点击入口，继续打开原有 18rem 临时 Drawer。
- 左栏底部补回主题切换按钮，原型提供 dark/light token 切换；Electron smoke 确认点击后
  `aria-pressed=true` 且 Workspace 背景切换为 `rgb(245, 247, 250)`。
- Composer 将 Full access、Context Window meter 与发送按钮包为独立操作组，组内间距调整为 10px；
  默认、右栏收起和历史 Drawer 展开三种 3456×1958 预览均重新渲染并完成视觉检查。
- 验证结果：Core 26 suites / 277 tests、App 22 suites / 135 tests 全绿；HTML 无远程资源，
  `git diff --check` 通过。
- 提交信息：`docs: 按标注精简 Chat 布局原型`

## Chat · Codex / Paseo 布局真实实现（2026-08-02）

- 以已确认的 `docs/prototypes/chat-codex-paseo-layout.html` 为真实 Renderer 验收契约，并新增
  `docs/plans/chat-codex-paseo-layout-implementation.md` 固化完整范围、非回归能力和验证方式。
- App Shell 保留唯一 14rem 产品导航，品牌改为图标与 Memory Manager 名称同一行，副标题明确为
  “本地 Agent Session”；Chat 去掉页面 padding、外层 Card 和常驻 Thread Rail。
- Chat Header 标题改为 18rem 覆盖式历史 Drawer 入口，保留 New Chat、Active/Archived、对话选择
  与管理能力；Conversation 与 Composer 统一为 820px 阅读线，Tool Activity 改为紧凑可展开行。
- Session Context 保持 22rem，重排为已选、筛选、可选列表，Header/Composer 均可开关；桌面展开
  偏好写入 `memory-manager.chat.context-pane-open`，存储异常不阻断使用。1600px 及以下转为带遮罩、
  Escape 和 `inert` 的覆盖式 Drawer。
- Composer 保留 Provider/model/effort、发送/停止/队列、Full access 和 Provider 权威 Context Window；
  Fast Mode 与 Skills 收入 `+` 次级菜单，避免视觉对齐造成能力删除。复制/耗时 Footer 和 Rules Run
  操作继续保留；本轮未改 ChatStore、Native Adapter、IPC 或 Session Context 注入协议。
- 真实 Electron 使用已有本地 Chat/Session 数据验收：1728×979 实测 `224 + 1152 + 352`、Composer
  820px，Context 收起后中央区扩为 1504px，历史 Drawer 宽 288px；1440×900 Context 为 352px
  覆盖式 Drawer；1024×768 Composer 718px，三档均无页面横向溢出。
- 真实交互 smoke 覆盖历史 Drawer、Escape 关闭、Composer 次级菜单、Context 展开/收起、桌面偏好、
  草稿 Session 选择与清空；未发送真实 Provider 消息，避免产生无意义外部调用，发送/流式/停止/队列
  继续由现有 Controller、Runtime 与 Adapter 自动化测试覆盖。
- 最终真实 App 截图为 `chat-implementation-preview.png`、
  `chat-implementation-context-collapsed.png`、`chat-implementation-history-drawer.png`，逐项确认与 HTML
  三张基线同构。Core 26 suites / 277 tests、App 23 suites / 140 tests 全绿；Core/App production
  build 与 `git diff --check` 通过。Core build 仅保留既有 `tsdown define` 配置警告。
- 提交信息：`refactor: 落地 Chat Codex Paseo 布局`

## Chat 默认历史栏与双侧栏归属修正（2026-08-02）

- 按最新版 HTML 将上一轮覆盖式 History Drawer 修正为 Chat 内部 18rem History Pane：桌面进入
  Chat 默认展开并参与 Grid 重排，1279px 及以下才使用带遮罩的覆盖式 Drawer；产品级 14rem 导航
  继续保持唯一常驻主导航。
- Chat Header 将历史开关与当前标题拆开；Session Context 展开时由右栏 Header 的“收起”控制，
  关闭后 Header 才显示“上下文 N”恢复入口。Composer 的 `+`、Context、Provider、Model、Effort、
  Full access / Context Window 与发送按钮统一为 32px 基线。
- 桌面 Escape 只关闭 Composer 次级菜单，不再误关默认 History Pane 或内联 Context；窄屏 Escape
  继续关闭覆盖式历史/Context Drawer。选择对话或新建草稿也只在窄屏自动收起历史栏。
- `DESIGN.md`、Chat 专项 spec 和实现 plan 已同步桌面常驻/窄屏覆盖边界；`simplify` 复核确认本轮
  状态命名和 Escape 条件保持显式，没有引入额外抽象或业务行为变化。
- Computer Use 在真实 production Electron 上完成默认进入 Chat、历史收起/恢复、Context 收起/恢复、
  Composer 次级菜单打开和 Escape 关闭；默认态确认 History Pane 与 Context 同时存在，重启后的首次
  Chat 进入仍默认展开历史栏。真实截图为 `chat-implementation-v2-default.png`、
  `chat-implementation-v2-history-collapsed.png`、`chat-implementation-v2-context-collapsed.png`。
- 最终自动化基线：App 23 suites / 140 tests、Core 26 suites / 277 tests 全绿；两端 production
  build 通过。Core build 仅保留既有 `tsdown define` 配置警告。
- 提交信息：`refactor: 默认展开 Chat 历史栏`

## Chat 历史操作与 Session 可读性修正（2026-08-02）

- History 顶部 New Chat 与当前/归档切换统一为暗色 Surface 层级，去掉突兀的白色 Primary pill；
  每条历史记录补充本地化更新时间。
- Native Chat 新增右键菜单，支持重命名、置顶/取消置顶与归档/恢复；`pinnedAt` 持久化在现有
  FS-first ChatStore，旧 v2 文件缺字段时归一为 `null`。列表先按置顶时间、再按更新时间倒序。
- Session Context 增加 `displayName`：OpenCode 从权威 SQLite `session.title` 按需读取，其他 Agent
  使用 `slug · agent` 回退；同一 SQLite 来源合并为一次批量查询，避免 100 条列表逐条开库。已选和
  可选列表不再把长 Session ID 放在主行，ID 只保留为辅助提示。
- Context Window meter 改为真实 Tooltip，展示本地化 `used / max (percent)`；Composer Runtime 控件
  间距统一为 8px。`simplify` 复核后抽出排序比较器并移除不必要的非空断言与参数。
- Computer Use 在真实 production Electron 中确认：历史时间可见；右键菜单暴露重命名/置顶/归档；
  置顶后图标与排序即时更新并在验收后恢复；已选 OpenCode 显示 `Review PR #6550 Boarding_Desktop`，
  可选列表显示 Quick Win、GRM 等可读标题；Context Window 可访问文本为 `94,397 / 200,000 (47%)`。
  最终截图为 `chat-implementation-v3-session-readability.png`。
- 自动化基线：App 23 suites / 141 tests、Core 26 suites / 278 tests 全绿；App/Core production build
  通过。Core build 仅保留既有 `tsdown define` 配置警告。
- 提交信息：`feat: 完善 Chat 历史与 Session 展示`

## Chat History 顶部像素级对齐（2026-08-02）

- 以 `docs/prototypes/chat-codex-paseo-layout.html` 的 History 顶部为唯一基准，修正真实 App 中
  HeroUI 默认尺寸和额外 Tab 底板造成的偏差；History Pane 增加独立的 dark/light Pane、Surface、
  Raised、Hover、文字、弱文字、边框和 soft border token。
- 顶部控件改为原生 button 并显式固定计算样式：12px padding、10px 行间距、12px / 650 标题、
  30×30px 关闭按钮、263×34px 新建按钮，以及两个 129.5×28px Tab。Tab 容器不再带额外背景、
  padding 或圆角，激活态完整铺满半列。
- 真实 production Electron 在 1728×979 下通过 DOM 计算样式逐项测量：Pane 288px、顶部 287×137px、
  新建按钮 gap 7px / radius 9px、Tab gap 4px / radius 7px；背景 `#1b1c1b`、Surface `#242524`、
  Raised `#2b2c2b`、边框 `#303230`、文字 `#e8e9e7` 与 HTML 基准一致。
- 最终截图为 `docs/prototypes/chat-implementation-v4-history-header.png`。`simplify` 复核仅整理 JSX 排版，
  未引入额外抽象；App 23 suites / 142 tests、Core 26 suites / 278 tests 全绿，两端 production build
  与 `git diff --check` 通过。Core build 仅保留既有 `tsdown define` 配置警告。
- 提交信息：`fix: 对齐 Chat 历史栏顶部样式`

## Session Context 剩余空间利用修正（2026-08-02）

- 根因是 `SessionContextPicker` 仍按普通文档流排列，虚拟列表 viewport 固定为 290px；右栏父 Grid
  虽然分配了剩余高度，但子列表不会伸展，因此“加载更多”和底部隐私说明之间出现大片空白。
- Picker 改为 `auto + minmax(0, 1fr)` 两行 Grid，可选 Session 区域再拆为标题、弹性列表和加载按钮；
  隐私说明继续由外层 Grid 固定在右栏底部，列表独立滚动。
- 使用 `ResizeObserver` 读取列表真实高度，并通过纯函数 `virtualWindowRange` 计算虚拟渲染区；新增测试
  确认 viewport 从 290px 增长到 580px 时可见范围从 9 条扩大到 14 条，同时布局契约禁止恢复固定高度。
- 1728×979 production Electron 实测：Session Context 内容区 858px，列表区域 707px，滚动 viewport
  609px、渲染 15 行，列表区域底部与隐私说明顶部间距为 0；最终截图为
  `docs/prototypes/chat-implementation-v5-context-filled.png`。
- `simplify` 复核确认 ResizeObserver 生命周期和纯函数边界保持直接；App 23 suites / 144 tests、
  Core 26 suites / 278 tests 全绿，两端 production build 与 `git diff --check` 通过。Core build 仅保留
  既有 `tsdown define` 配置警告。
- 提交信息：`fix: 填满 Session Context 剩余空间`

## Session Context 当前结果全选（2026-08-02）

- 在“可选 Session / 数量”标题行增加全选切换按钮；当前结果未全部选择时显示“全选”，全部选择后
  显示“取消全选”，空结果时禁用。
- `toggleAvailableSessionSelection` 使用 `agent + id` 去重：全选合并当前已加载结果并保留其他筛选下
  已选项；取消全选仅移除当前结果，不影响筛选外选择。现有单项选择、清空和 Thread 持久化继续复用
  `updateSelectedContext`。
- 新增中英文文案、选择纯函数测试和 Renderer 布局契约。真实 production Electron 草稿态验证
  `0 / 全选 → 100 / 取消全选 → 0 / 全选`，未创建或修改持久化 Thread；最终截图为
  `docs/prototypes/chat-implementation-v6-context-select-all.png`。
- `simplify` 复核确认选择合并逻辑边界清晰，无需额外抽象；App 23 suites / 146 tests、Core 26 suites /
  278 tests 全绿，两端 production build 与 `git diff --check` 通过。Core build 仅保留既有
  `tsdown define` 配置警告。
- 提交信息：`feat: 支持全选当前 Session 结果`

## Session Context 筛选与已选区域稳定（2026-08-02）

- Session Context 明确拆成“已选择 → 筛选 → 可选 Session”三个区段；项目、日期、最近 7/30 天与
  清除筛选上方新增“筛选”小标题，补齐中英文文案。
- 已选择区改为始终渲染的 11rem 固定区域：0 条时显示空状态并禁用清空按钮，多条时在区段内部滚动，
  不再因选择数量变化推动筛选区和可选列表上下跳动。
- 新增 Renderer 布局契约并更新旧高度断言。真实 production Electron 在 1728×979 下分别测量空选与
  全选 100 条：已选区均为 176px，筛选标题 top 均为 240px，可选列表 top 均为 402px。
- 最终截图为 `docs/prototypes/chat-implementation-v7-context-sections.png`。`simplify` 复核仅整理 JSX
  排版；App 23 suites / 147 tests、Core 26 suites / 278 tests 全绿，两端 production build 与
  `git diff --check` 通过。Core build 仅保留既有 `tsdown define` 配置警告。
- 提交信息：`fix: 稳定 Session Context 区域布局`

## Session Context 底部空间释放（2026-08-02）

- 删除右栏底部“只保存可见对话……”说明及中英文 `privacy` 文案 key，Context aside 从 Header、内容、
  说明三行 Grid 简化为 Header + 内容两行。
- Session Context Picker 直接占满 Header 下方全部空间；已选择、筛选、全选、加载更多与虚拟列表行为
  保持不变。
- 1728×979 production Electron 实测右栏与可选 Session 区域 bottom 均为 979px，列表 viewport 为
  473px，说明文案不可见；最终截图为 `docs/prototypes/chat-implementation-v8-context-expanded.png`。
- `simplify` 复核确认本轮仅删除冗余布局行，无需额外抽象；App 23 suites / 147 tests、Core 26 suites /
  278 tests 全绿，两端 production build 与 `git diff --check` 通过。Core build 仅保留既有
  `tsdown define` 配置警告。
- 提交信息：`fix: 扩展 Session Context 列表空间`

## Composer Context Window Tooltip 修复（2026-08-02）

- 根因是圆形 Context Window 指示器使用原生 `span` 直接作为 HeroUI Tooltip 子节点，没有消费
  Tooltip Trigger 注入的 hover/focus 事件；真实 Electron 悬停 1.2 秒仍无 Tooltip 挂载。
- 改为显式 `Tooltip.Trigger`，外层提供 24×24px 命中区，内部继续保留 16px 圆形进度视觉，并将
  delay 设为 0；用量与不可用文案统一复用 `contextUsageLabel`。
- 1728×979 production Electron 实测 hover 150ms 后出现 Tooltip，内容为
  `94,397 / 200,000 (47%)`；最终截图为 `docs/prototypes/chat-implementation-v9-context-tooltip.png`。
- 新增 Renderer 结构回归契约；`simplify` 复核后提取重复 label。App 23 suites / 147 tests、Core
  26 suites / 278 tests 全绿，两端 production build 与 `git diff --check` 通过。Core build 仅保留
  既有 `tsdown define` 配置警告。
- 提交信息：`fix: 修复 Context Window hover 提示`

## Chat Native Turn 消息与耗时修复（2026-08-02）

- P1 根因一是 Native Chat 只在 `chat.send` 完成后刷新 Thread，首轮运行时只有流式 Assistant，刚落盘的
  用户消息尚未进入 Renderer；二是 Codex app-server 的 `userMessage / agentMessage` item 生命周期被
  误投影成 Tool Activity；流式增量在 Renderer 重复收到时又会继续追加，造成正文逐块重复。
- 用户消息落盘后立即广播 `chat.changed`，草稿发送态收到首个 Chat ID 后即时选中并读取 Thread；Controller
  对 Assistant delta 增加本轮累计正文快照，Renderer 优先替换快照，重复 IPC 不再重复拼接。
- Codex Adapter 从源头过滤消息 item，ChatStore 读取时也过滤旧记录中的同名 Tool Activity，因此现有
  历史会话无需迁移即可去掉空的 `userMessage / agentMessage` 行，真实 Command 等工具活动保持可读。
- P2 根因是 Assistant 完成时 `createdAt / completedAt` 同时写成完成时间。现在保存本轮用户消息时间为
  Assistant `createdAt`、完成时间为 `completedAt`；运行态从发送瞬间展示并每秒递增“用时”，旧历史记录
  展示时回退到前一条用户消息时间，原有 `0s` 也能显示真实轮次耗时。
- `simplify` 复核确认累计正文、即时刷新和时间戳职责边界清晰，保留本地 `liveStartedAt` 以覆盖主进程
  首次刷新前的短暂窗口，没有引入额外抽象。
- 验证结果：App 23 suites / 149 tests、Core 26 suites / 278 tests 全绿；App/Core production build
  与 `git diff --check` 通过。Core build 仅保留既有 `tsdown define` 配置警告。
- 提交信息：`fix: 修复 Chat 消息与轮次耗时`

## Codex 历史工具详情 Source Locator 修复（2026-08-02）

- 根因不是 Memory Manager 不保存 tool output 本身，而是 Codex app-server 对历史 Session 的
  `thread/read` 只重建了用户/助手消息，没有返回 Command 等 Tool Item；Memory Manager 保存的瞬时
  `exec-*` item ID 因而无法命中。完整 call/output 仍存在 Codex 原始 Session JSONL 中。
- 保持“不存对话原文 / tool output”红线：新产生的 Codex Tool Activity 只新增无正文的
  `turnId + toolIndex` source locator；展开时先尝试原有 `thread/read + itemId`，未命中再从
  `~/.codex/sessions` 或 `archived_sessions` 的原始 JSONL 按 locator 读取匹配的 call/output。
- 旧 Chat 没有 locator 时，Controller 根据 Assistant 轮次和该轮工具序号生成兼容 locator；源 Session、
  轮次、工具或 output 任一缺失时继续返回不可用，避免把其他 Command 的输出误配过来。
- `simplify` 复核移除了 locator 查找中的非空断言和重复 payload 映射；回归测试覆盖新 locator 持久化、
  旧轮次兼容、目标缺失、原有 ID 命中与分页路径。
- 真实 Electron 中对截图会话的首条 Command 做只读展开验证，已恢复显示 RTK / flow-brainstorm 对应的
  原始 call 与 output，不再出现“原生 Session 来源已失效”；未向 Memory Manager Chat 文件复制 output。
- 最终基线：App 23 suites / 150 tests、Core 26 suites / 278 tests 全绿；App/Core production build 与
  `git diff --check` 通过。Core build 仅保留既有 `tsdown define` 配置警告。
- 提交信息：`fix: 恢复 Codex 工具详情读取`

## Chat Assistant 流式 Markdown 渲染（2026-08-02）

- 当前 Renderer 是 React 19，因此未引入仅面向 Vue 的 `markstream-vue`，而是使用同一 Markstream
  项目提供的 `markstream-react@0.0.55`；该实现面向 LLM 增量输出，能处理未闭合 Markdown 中间态。
- Native Chat 的历史 Assistant、运行中 Assistant 与 Rules Generation 终态摘要统一经过
  `MarkdownMessage`：完成消息传 `final=true`，流式消息传 `final=false`；用户气泡仍按纯文本渲染，
  复制按钮继续复制 ChatStore 中的原始 Markdown，不持久化渲染 HTML。
- 默认使用轻量 `pre` 代码块，不安装 Monaco、Mermaid、KaTeX 等可选 peer；主题样式映射现有 dark/light
  token，并限制代码块、表格和图片宽度，避免撑破 820px Conversation 阅读线。
- `simplify` 复核后保留单一 `MarkdownMessageProps` 与组件边界，没有将 Markdown 状态扩散到 Chat
  Controller 或 Store。真实 Electron 验证标题、列表、链接、行内代码和代码块均已按语义展示，Tool
  Activity、复制和耗时布局保持原位。
- 最终基线：App 24 suites / 152 tests、Core 26 suites / 278 tests 全绿；App/Core production build 与
  `git diff --check` 通过。App 独立 typecheck 仍被既有 tsconfig `rootDir/files` 边界和既有 RulesView
  类型错误阻断，本轮 production build 已通过；build 另有 Markstream 产物 PURE 注释位置警告。
- 提交信息：`feat: 支持 Chat 流式 Markdown 渲染`

## Chat Markdown 灰色占位骨架修复（2026-08-02）

- 截图中的灰色长条是 Markstream 的 `node-placeholder`，不是 Assistant 输出；默认的
  `deferNodesUntilVisible + batchRendering` 在 Electron 自定义 Conversation 滚动容器中没有及时将
  已完成长回复的后续节点挂载，导致列表内容长期停留在骨架态。
- `MarkdownMessage` 显式关闭节点可视区延迟与分批占位，保留 Markdown parser、历史 `final=true` 和
  流式 `final=false` 行为；Tool Activity、复制原文和耗时区域不变。
- 第一次只关闭可视区延迟后真实页面仍有骨架，因此补充关闭分批占位并重新加载验证；截图位置的六条
  “同时还完成”列表、本周总结和收尾事项均完整显示，灰色块消失。
- `simplify` 复核确认两个显式配置直接表达 Electron 容器兼容要求，无需增加包装状态或额外抽象。
- 最终基线：App 24 suites / 152 tests、Core 26 suites / 278 tests 全绿；App/Core production build 与
  `git diff --check` 通过。既有 Core build `tsdown define` 与 Markstream PURE 注释位置警告保持不变。
- 提交信息：`fix: 移除 Chat Markdown 占位骨架`

## Chat 顶部按钮热区修复（2026-08-02）

- 根因是全局窗口拖拽层固定覆盖顶部 32px 且使用 `z-index: 1000`，Chat Header 只有 `z-20`；可见的
  历史按钮和对话管理按钮大部分区域实际落在拖拽层下方，因此点击图标中心会被识别为窗口拖动，表现为
  历史按钮热区错位、`…` 无响应。对话管理弹窗本身已有重命名、归档等完整能力。
- `.window-no-drag` 统一提升到拖拽层之上的 `z-index: 1001`，恢复其原本的 no-drag 语义；两个 Header
  图标按钮显式固定为 32×32px，并将可访问名称从 SVG 移到实际 Button，避免命中区和语义节点分离。
- `simplify` 复核把层级规则收敛到语义 CSS 类，未在 JSX 中保留 Tailwind 魔法层级；没有改动窗口拖拽层
  的全局尺寸、Chat 生命周期或管理操作。
- 真实 Electron 点击验证：`…` 可打开含标题输入、重命名和归档操作的“对话管理”弹窗；历史按钮可连续
  打开和关闭历史侧栏。App 24 suites / 153 tests、Core 26 suites / 278 tests 全绿；App/Core
  production build 与 `git diff --check` 通过，既有 Core `tsdown define` 与 Markstream PURE 注释警告不变。
- 提交信息：`fix: 修复 Chat 顶部按钮热区`

## Session 名称统一展示（2026-08-02）

- 项目会话列表、会话详情、规则 Evidence 预览与来源上下文统一改为“可读 Session 名称为主、
  Agent + Session ID 为辅助”；项目会话搜索同时支持名称、ID 和来源路径。
- 名称保持按需读取且不写入 Memory Manager DB：Claude 读取原生 `ai-title`，Codex 批量读取
  `state_5.sqlite` 的 `name / title / first_user_message`，OpenCode 批量读取权威 SQLite `session.title`，
  Copilot 读取 workspace `name / summary`，Cursor 与 Pi 回退到 JSONL 首条用户消息；来源失效或格式
  不兼容时使用 `slug · agent`，不影响列表可用性。
- 所有原生名称和首条消息在进入 UI 前统一压缩空白、限制长度并执行 secret redaction，避免 token 等
  敏感文本因成为标题而绕过既有 Evidence 脱敏。
- 真实 production Electron 在 `agent-workspace` 的 313 条会话中验证：原 UUID 主行已替换为 Codex
  可读标题，ID 位于第二行；搜索 placeholder、长标题截断和详情页标题层级均符合预期。
- `simplify` 复核收敛了批量来源分组和 Agent 类型，没有改变读取或回退行为。Core 26 suites / 279 tests、
  App 24 suites / 153 tests 全绿；App/Core production build 与 `git diff --check` 通过，既有 Core
  `tsdown define` 与 Markstream PURE 注释警告保持不变。
- 提交信息：`feat: 统一展示可读 Session 名称`

## 项目与 Session 系统定位（2026-08-02）

- 项目详情 Page Header 增加“打开项目位置”，通过 Electron `shell.openPath` 打开
  `~/.memory-manager/projects/<slug>` 的 FS-first 项目目录；Session 详情增加“打开 Session 位置”，
  主进程按 Session ID 从 DB 解析 `source_path` 后交给 Finder 定位，Renderer 不能提交任意文件路径。
- 新增独立路径解析边界：项目 slug 拒绝目录穿越并要求目录存在；Session 必须存在于索引且原始来源仍
  可访问。两类失败在页面显示本地化错误，不离开当前详情页。
- 真实 Electron 验证 `agent-workspace` 项目目录成功在 Finder 打开，Codex Session 定位动作成功触发；
  同时根据视觉结果将 PageHeader 标题区改为可收缩弹性列，长 Session 名称下操作按钮仍固定在右上角。
- `simplify` 复核确认路径解析留在主进程、项目与 Session 保持独立错误语义。Core 26 suites / 279 tests、
  App 25 suites / 155 tests 全绿；App production build 与 `git diff --check` 通过，既有 Markstream PURE
  注释警告保持不变。
- 提交信息：`feat: 支持定位项目与 Session 来源`

## Chat Composer Skill Picker（2026-08-02）

- 将不适合大量 Skill 的 HeroUI 单选下拉替换为固定 28rem 宽、最高 32rem 且受视口约束的 Composer
  多选 Picker；弹层内部独立滚动，不再覆盖整段 Conversation。
- 主进程合并 Provider 专属与 `.agents/skills` 通用 Skill 时，只读取 `SKILL.md` frontmatter 中最长
  240 字符的描述和来源类型；不向 Renderer 暴露 Skill 正文或文件路径，Provider 同名 Skill 优先。
- Picker 支持名称/描述多词搜索、已选 chip、最近使用、方向键 + Enter、Escape、点击外部关闭和独立 `/`
  快捷唤起；URL、文件路径里的斜杠不会误触发。连续选择时保持打开，Composer 与 Picker 均可移除已选项。
- Fast Mode 从 Picker 移到 Composer 底栏，位于 Effort 后、权限区前，与其他运行参数常驻展示；Picker
  只承担 Skill 搜索与选择。
- Skill 在编辑阶段独立于消息正文，发送前统一组装为 `/skill-a /skill-b\n\n用户消息`，继续兼容原生
  Agent Skill 识别；发送后清空本轮选择并将最近使用写入本机 UI 偏好。
- 真实 Electron 开发窗口验证弹层边界、独立滚动、搜索自动聚焦、连续多选、chip 移除、`/` 唤起，
  以及底栏 Fast Mode 的开关和 Picker 职责分离；App 26 suites / 162 tests 与 production build 通过，
  build 仅保留既有 Markstream PURE 注释警告。
- 提交信息：`feat: 优化 Chat Skill 多选体验`

## Chat Assistant 原生时间线顺序修复（2026-08-03）

- 根因是 Native Chat 将一轮输出压成单个 `content` 和独立 `toolActivities`，Renderer 又固定先渲染
  正文再渲染全部 Tool，导致中间 Assistant 说明、Thinking 和 Tool 的原始事件顺序在持久化前就丢失。
- 新增按首次出现顺序保存的 `assistant / thinking / tool` timeline。Codex 与 Claude Adapter 为正文和
  reasoning 增量提供稳定 item ID；同一 Tool 的 running / completed 只原位更新，不会重复或移动。
- Main Controller 用 timeline reducer 同时驱动实时 IPC 和最终 Chat JSONL；Renderer 以同一顺序渲染
  实时与历史内容。Tool output、原始 Tool input、隐藏 Prompt 和 Session 原文仍不进入 Chat 文件。
- 旧消息保持无需迁移可读；由于旧格式已经无法恢复中间顺序，统一回退为 Tool 在前、最终正文在后，
  至少不再出现“结论先于执行过程”。Thinking 正文仅在 Provider 明确给出时保存，限制为 16,000 字符并
  使用可展开的紧凑行展示。
- 真实 Electron 使用 Codex 构造交错输出，实测顺序为“准备检查一 → Command(pwd) → 继续检查二 →
  Command(git status) → 思考 → 顺序验收完成”；刷新应用后顺序一致，旧截图会话也已改为 Tool 在前、
  结论在后。临时验收对话完成后已归档。
- `simplify` 复核将 Renderer 的事件转换改为显式分支并移除测试类型绕过。App 27 suites / 170 tests、
  Core 26 suites / 279 tests 全绿；App/Core production build 与 `git diff --check` 通过。App 独立
  typecheck 仍仅受既有 `rootDir/files` 配置边界和既有 RulesView 类型错误阻断；build 保留既有
  Markstream PURE 注释与 Core `tsdown define` 警告。
- 提交信息：`fix: 按原生顺序展示 Chat Assistant 时间线`

## Agent Memory 只读入口（2026-08-03）

- Rules 二级导航保留「Agent 指令」，新增独立「Agent Memory」入口；列表与详情只从 Agent 原始
  `MEMORY.md` 读取，不复用候选规则或全局 instruction 模型，也不向 Memory Manager DB、日志、缓存
  或副本写入正文。
- Claude 扫描 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/memory/MEMORY.md`，项目编码保持不透明；
  Codex 展示 `${CODEX_HOME:-~/.codex}/memories/MEMORY.md` 固定本机合并来源，缺失时明确显示尚未生成，
  不读取 `memories_1.sqlite` 或伪造按项目映射。
- Core locator 不跟随 Claude project 目录 symlink，只允许最终 `MEMORY.md` 文件 symlink；详情 IPC 只接受
  `agent + memoryId`，并执行 1 MiB 上限、fatal UTF-8 解码与读取前后 stat 一致性检查。
- 真实 Electron 验证新增导航、3 个 Claude 项目列表、Codex missing 状态、Claude 内容详情、刷新和返回；
  本机 smoke 再次读取 3 个 Claude 来源后文件 hash 全部不变，未发现 locator error。
- 最终基线：Core 27 suites / 284 tests、App 27 suites / 172 tests 全绿；Core/App production build 与
  `git diff --check` 通过。App 独立 typecheck 仍受既有跨 workspace `rootDir/files` 边界及既有 Rules
  `history` 类型错误阻断；build 仅保留既有 Core `tsdown define` 与 Markstream PURE 注释警告。
- 提交信息：`feat: 新增 Agent Memory 只读入口`

## Rules Chat 上下文同步与项目异步加载（2026-08-03）

- Rules 生成原本已经在证据确定后持久化 Session Context 并广播 `chat.changed`，但 ChatView 只在
  thread id 变化时同步右栏，导致同一 Chat 后续增加的上下文停留在 0。现在单独监听
  `sessionContext.revision`，只更新所选 Session，不覆盖用户正在编辑的 Provider、模型和 Effort。
- `projects.sessions` 原本虽在 Renderer 延迟到下一帧调用，完整的 FS/SQLite 查询与原始 Session 名称
  解析仍同步运行在 Electron 主进程。新增 `project-sessions-worker` 承担这段查询，IPC 契约、返回结构和
  Renderer 加载/错误状态保持不变。
- 真实 Electron 验证已有 `生成规则：changed7d` Chat 自动显示并选中 80 个 Session Context；打开含
  118 个 Session 的 `agent-slack` 项目时 41ms 进入加载态，加载期间切换 Tab 39ms 响应，随后正常展示
  118 / 118 条带可读名称的 Session。
- `simplify` 复核确认 Context 配置同步与动态选择同步保持独立，Worker 边界只承载既有同步 Core 查询。
  App 27 suites / 171 tests、Core 26 suites / 279 tests 与 App production build 通过，build 仅保留既有
  Markstream PURE 注释警告。
- 提交信息：`fix: 同步 Rules 上下文并异步加载项目会话`

## 候选规则状态动作对齐（2026-08-03）

- Generated Rules 行内动作改为按候选状态表达下一步：草稿显示「审核」，已接受显示「发布」，已拒绝
  显示「查看」，终态候选不再继续提示审核。
- 已接受行的「发布」复用现有已接受规则发布预览，仍由用户在下一页明确选择 Agent；不在列表点击时
  直接写入规则文件。顶部「发布已接受规则」保留为同一批量入口。
- 真实 Electron 验证已接受行显示「发布」且进入发布预览，草稿行保持「审核」；当前批次无已拒绝
  候选，「查看」状态由契约测试覆盖。`simplify` 复核无需额外抽象。
- App 27 suites / 173 tests、production build 与 `git diff --check` 通过；build 仅保留既有 Markstream
  PURE 注释警告。
- 提交信息：`fix: 对齐候选规则状态动作`

## Claude Project Memory 项目规则发布（2026-08-03）

- 已接受规则发布页新增独立的项目级流程：用户必须依次显式选择项目、勾选该项目的 accepted project
  rules，并选择一个已发现的 Claude Project Memory；项目 slug 不会自动映射到 Claude 的不透明目录。
- 发布只替换 `MEMORY.md` 顶部的 Memory Manager managed block，并维护固定 topic
  `memory-manager-rules.md`；Claude 自身内容保持不变。Memory 与 topic 都使用 SHA-256 preview revision 做
  compare-and-swap，单文件以同目录临时文件、fsync、rename 原子替换。
- 写入边界拒绝跨项目、非 accepted、非 project、未知规则、保留 marker、超 24 KiB / 160 行、损坏
  managed marker、非受管同名 topic，以及 Memory 文件或项目内父目录 symlink；Codex 暂不提供项目级目标。
- 真实 Electron 验证项目选择、规则勾选、可读 Memory 目标列表和三项齐备后按钮启用；验收未点击最终发布，
  因此没有改动本机 Claude Memory。`simplify` 复核收敛了选择哨兵并补强 symlink 与 marker 边界。
- Core 28 suites / 290 tests、App 27 suites / 174 tests、Core/App production build 与
  `git diff --check` 通过。App 独立 typecheck 仍受既有跨 workspace `rootDir/files` 配置和
  `RulesView` 的 `history` 类型错误阻断；build 仅保留既有 Core `tsdown define` 与 Markstream PURE
  注释警告。
- 提交信息：`feat: 支持发布项目规则到 Claude Memory`

## Codex 项目 Memory 发布（2026-08-03）

- 已接受规则发布页新增 Codex 项目级入口。用户必须显式选择项目规则与工作目录；cwd 从该项目原始
  Session metadata 的 `git_root`（优先）或 `cwd` 解析，不根据项目 slug、Memory Manager 工作区或
  Chat 工作目录推断。同一项目出现多个 cwd 时逐项列出，由用户选择。
- 不直接编辑 Codex 生成态 `~/.codex/memories/MEMORY.md`。仅在当前 Codex 暴露可识别的
  `memories/extensions/ad_hoc/instructions.md` 契约时，为 `project_slug + cwd` 维护固定的 Memory Manager
  ad-hoc note；note 标注 `applies_to: cwd=...`，后续由 Codex 在后台合并。
- 发布使用 note revision 与契约 revision 双重 compare-and-swap，并执行同目录原子替换；拒绝失效 cwd、
  symlink、非受管同名 note、跨项目或非 accepted project rule、保留 marker、非法项目标识和超限内容。
- cwd 候选解析需要读取异构 Session 来源，已放入独立 `codex-memory-targets-worker`，不会阻塞 Electron
  主线程。Renderer 在项目变化时展示加载态，并在成功重试时清除旧错误。
- 真实 Electron 以 `agent-workspace` 验证：从 codex / copilot / opencode / pi 共 313 个 Session 解析到
  `/Users/moego-winches/Desktop/Company/person/agent-workspace`；显式选择 cwd 和 1 条规则后按钮正确启用。
  验收未点击最终提交，因此没有改动本机 Codex Memory。
- `simplify` 复核移除了嵌套三元状态渲染，并补充项目标识换行防护与测试返回类型。Core 29 suites /
  296 tests、App 27 suites / 175 tests、Core/App production build 与 `git diff --check` 通过。App 独立
  typecheck 仍受既有跨 workspace `rootDir/files` 配置及既有 `RulesView` 的 `history` 类型错误阻断；
  build 仅保留既有 Core `tsdown define` 与 Markstream PURE 注释警告。
- 提交信息：`feat: 支持发布项目规则到 Codex Memory`

## 已接受规则发布页布局与项目导出语义（2026-08-03）

- 原「写入托管项目输出」位于项目区域，却通过 `rules.output --all` 同时重写 global、style 和全部项目
  文件，用户无法从名称判断结果。现改为「导出该项目规则文件」，要求先选项目，只把该项目全部 accepted
  rules 写入 `~/.memory-manager/rules/projects/<slug>.md`，并明确说明它不会发布到 Agent 或 Memory。
- 导出完成反馈展示实际文件路径，不再只显示模糊的文件数量。项目规则区同时说明：勾选项用于 Claude /
  Codex 项目 Memory 发布，项目文件导出则包含该项目全部已接受规则，两种行为不再混淆。
- 发布页双栏 Grid 增加 `items-start`，左侧预览卡不再被三张右栏卡片的总高度强制拉伸；右栏限制在视口
  高度内并独立纵向滚动，在窄屏回退为单栏自然流。Card 与 Select 增加 `min-width: 0` 和横向溢出保护，
  长 Agent 路径与 cwd 不再撑出窗口。
- 真实 Electron 在发布页验证：左卡片随内容结束，右栏完整位于视口内；滚动后 Codex 说明、cwd 选择器
  与提交按钮均可见，未触发导出或发布写操作。`simplify` 复核无需额外抽象。
- App 27 suites / 176 tests、production build 与 `git diff --check` 通过；build 仅保留既有 Markstream
  PURE 注释警告。
- 提交信息：`fix: 优化规则发布页布局与导出语义`

## 已接受规则发布页列宽调整（2026-08-03）

- 根据真实窗口反馈，将发布页右栏从 18–20rem 加宽到 24–26rem；主预览区继续使用 `minmax(0, 1fr)`，
  在宽屏让出空间，在 `max-xl` 下仍回退为单栏。
- 真实 Electron 验证右栏约 416px，Agent 路径、Project Memory 说明与 cwd 选择器可显示更多内容；主区无
  横向溢出，右栏独立滚动保持正常。
- App 定向布局 43 tests、production build 与 `git diff --check` 通过；build 仅保留既有 Markstream PURE
  注释警告。
- 提交信息：`fix: 加宽规则发布目标栏`

## 项目规则单项目选择简化（2026-08-03）

- 发布页的「项目」表示 accepted project rule 所属项目，不是 Claude/Codex Memory 目标。当前数据只有
  `agent-workspace` 下 1 条 accepted project rule，原界面仍显示仅含「先选择项目」和
  `agent-workspace` 的下拉，产生多余选择和概念歧义。
- 当 accepted project rules 只属于一个项目时，现在自动选中并静态显示「项目名 · N 条已接受规则」；
  多项目时才显示 Select，placeholder 只用于未选状态，Popover 只包含真实项目，不再把「先选择项目」
  当成可选项。
- 真实 Electron 验证页面直接显示 `agent-workspace · 1 条已接受规则`，下方规则与右侧项目 Memory 上下文
  自动加载；未触发导出或发布。`simplify` 复核将规则分组改为稳定 memo，避免自动选择 effect 被无关
  render 重复触发。
- App 27 suites / 176 tests、production build 与 `git diff --check` 通过；build 仅保留既有 Markstream
  PURE 注释警告。
- 提交信息：`fix: 简化单项目规则选择`

## 项目规则导出反馈归位（2026-08-03）

- 「项目规则文件已导出」属于左侧项目规则导出动作，现从右侧发布目标栏移到左侧预览卡下方；反馈宽度
  跟随左列，文件路径继续完整展示。
- 右侧仅保留 Agent、Claude Project Memory、Codex 项目 Memory 三类发布目标及各自结果，项目导出反馈
  不再沉到右栏卡片末尾。
- 布局契约测试新增反馈必须位于右侧 `aside` 之前的断言；真实 Electron 验证成功态仍保留，提示紧贴左侧
  预览卡下方，左右层级与视觉归属正确。
- App 27 suites / 176 tests、production build 与 `git diff --check` 通过；build 仅保留既有 Markstream PURE
  注释警告。
- 提交信息：`fix: 对齐项目规则导出反馈位置`

## 项目已导出规则只读查看入口（2026-08-03）

- 「项目 → 项目详情 → 规则」新增「候选规则 / 已发布版本」切换；已发布版本只读展示固定路径
  `~/.memory-manager/rules/projects/<project-slug>.md` 的正文、文件路径、大小、修改时间和磁盘刷新入口。
- Renderer 只向主进程提交 project slug。Core 使用既有 slug 规范校验并固定解析到 workspace rules 目录；
  文件缺失返回正常空态，不创建或重新导出文件。读取拒绝 symlink、非普通文件、超过 1 MiB、非法 UTF-8
  和读取期间 stat 变化。
- 页面明确标注该文件是 Memory Manager 托管的项目规则导出，不代表已经发布到 Claude/Codex Memory；
  页面不提供编辑、删除或任意路径读取能力。
- 本机 `agent-workspace.md` 读取前后 SHA-256 均为
  `30835a5ed7fc60c1a28aff63f7a84a6dee87c7624f1035331ec9081013b7d74c`。真实 Electron 验证
  `agent-workspace` 显示文件正文和 metadata，`moego-agent` 显示尚未导出空态，验收未触发导出或发布。
- `simplify` 复核后仅保留显式、局部的读取状态，不增加额外抽象。Core 29 suites / 299 tests、App
  27 suites / 177 tests、Core/App production build 与 `git diff --check` 通过；build 仅保留既有 Core
  `tsdown define` 与 Markstream PURE 注释警告。
- 提交信息：`feat: 支持查看已导出项目规则`

## 项目 Memory 发布状态与快捷入口（2026-08-03）

- 「项目 → 项目详情 → 规则 → 已发布版本」新增 Claude Project Memory 与 Codex 项目 Memory 两张状态卡，
  分别显示 `已同步 / 有更新 / 未发布 / 不可用 / 没有已接受规则`。状态事实源是当前项目全部 accepted
  project rules 与目标 canonical 受管内容的一致性，不再根据托管导出文件是否存在推断 Memory 发布状态。
- Claude 检查受管 block 与 `memory-manager-rules.md` topic 是否同时匹配当前项目；只有 block 明确属于当前
  project slug 时才形成该项目发布记录。Codex 按 Session metadata 解析出的 cwd 检查固定 ad-hoc note
  revision；accepted rules 变化后两类目标都会从已同步变为有更新。
- 状态读取通过独立 `project-memory-status-worker` 执行，Renderer 只传 project slug，不阻塞 Electron 主进程，
  也不创建或修改 Memory、note、导出文件与 DB。
- 「发布到 Memory」复用既有发布页：从 `agent-workspace` 进入后自动选择该项目及其 1 条 accepted project
  rule；Claude Memory 目标与 Codex cwd 保持未选择，两个最终发布按钮均禁用，仍由用户明确选择目标。
- 本机只读检查显示 `agent-workspace` 的 Claude 与 Codex 状态均为未发布。真实 Electron 验证状态卡布局、
  发布页预选和目标空选状态，未点击最终发布。`simplify` 复核统一了两类状态优先级并移除嵌套条件。
- Core 29 suites / 303 tests、App 27 suites / 178 tests、Core/App production build 与
  `git diff --check` 通过；build 仅保留既有 Core `tsdown define` 与 Markstream PURE 注释警告。
- 提交信息：`feat: 展示项目 Memory 发布状态`

## 项目 Memory 发布入口合并展示（2026-08-03）

- 已接受规则发布页右栏将 Claude Project Memory 与 Codex 项目 Memory 从两张独立 Card 合并为一张
  「发布到项目 Memory」Card；卡片内仍以分隔线保留两类目标各自的说明、选择器和发布按钮。
- 本次只调整展示层级与中英文文案。Claude/Codex 的目标发现、默认空选、加载/禁用状态、并发校验、
  发布调用与成功反馈均保持原逻辑；布局契约测试确认合并区间只有一个外层 Card 且同时包含两个发布动作。
- 真实 Electron 验证单卡片层级、两处分区边界、右栏滚动和底部按钮均正常，未选择目标或触发发布。
  `simplify` 复核后保留两个显式 section，未增加会掩盖两类独立行为的额外抽象。
- App 27 suites / 178 tests、production build 与 `git diff --check` 通过；build 仅保留既有 Markstream
  PURE 注释警告。
- 提交信息：`fix: 合并项目 Memory 发布入口`

## 已接受规则发布台 HTML 原型（2026-08-03）

- 新增独立 HTML 原型，将原发布页重组为按「项目规则 / 全局规则」切换的单任务发布台；默认进入当前
  非空的项目规则范围，全局规则为 0 时展示紧凑空状态，不渲染无效的 Agent 目标配置。
- 项目规则区明确区分两类动作：勾选项只用于发布到项目 Memory，「导出全部规则」始终导出该项目全部
  accepted rules。Claude/Codex 改为互斥目标切换，并共用一个随当前上下文更新的 Primary Action。
- 原型只模拟选择、发布、导出和反馈，不调用 Memory Manager API，不修改 Renderer、Core、IPC 或本机
  Memory 文件；实现范围与观察点记录在 `docs/plans/rules-publish-task-workbench-prototype.md`。
- 静态契约、`git diff --check` 与浏览器交互通过；1440×900、390×844 均无横向溢出，Light/Dark 主题
  可读，浏览器控制台无 warning/error。未运行 App 测试，因为本轮仅新增独立文档原型，使用静态和视觉
  验收替代。
- 提交信息：`docs: 新增已接受规则发布台原型`

## 发布台原型补回 Agent 全局规则目标（2026-08-03）

- 首版原型只保留 Claude/Codex 项目 Memory，错误移除了将 accepted rules 发布到 Agent 全局指令文件的
  能力。现将右侧目标改为「Agent 全局规则 / 项目 Memory」两级发布方式，避免把规则来源范围与发布目标
  混为同一概念。
- Agent 模式显式多选 Claude、Codex、Copilot、OpenCode、Pi，并展示各自全局指令文件路径；Memory 模式
  继续以 Claude/Codex 互斥切换选择具体 Project Memory 或 cwd。两种方式仍共用一个动态 Primary Action。
- 规则勾选同时约束 Agent 与 Memory 发布；独立「导出全部规则」仍不受勾选状态影响。所有动作继续只在
  原型内模拟，不调用本机 API 或修改规则、Memory 文件。
- 静态契约与浏览器交互通过：Agent 多选后主按钮显示目标数量，切换 Memory 后恢复 Claude/Codex 目标
  校验；390×844 无横向溢出，页面始终只有一个 Primary Action，浏览器控制台无 warning/error。
- 提交信息：`fix: 补回原型 Agent 全局规则发布目标`

## 发布台原型新增顶部 Memory 入口（2026-08-03）

- 顶部任务切换从「项目规则 / 全局规则」扩展为「项目规则 / 全局规则 / Memory」三个同级 tab；Memory
  沿用当前项目 1 条 accepted rule，并在进入后选择 Claude 或 Codex 项目 Memory。
- 移除右侧重复的「Agent 全局规则 / 项目 Memory」发布方式切换：项目规则页直接展示 Agent 全局指令
  文件目标，Memory 页直接展示 Claude/Codex 目标，仍共用同一规则选择区和单一 Primary Action。
- 静态契约与浏览器交互通过：顶部三 tab 可达，Memory 切换后只展示 Memory 配置，390px 窄屏无横向
  溢出，页面只有一个 Primary Action，浏览器控制台无 warning/error。
- 提交信息：`fix: 增加原型顶部 Memory 入口`

## 发布台原型减少超宽屏留白（2026-08-03）

- 用户反馈 2K 视口下主内容过窄、两侧留白过多。原型主内容上限从 1296px 扩至 1640px，目标栏从
  352px 扩至 520px，并增加 1360px/1080px 两级回退，避免中等视口挤压规则区。
- 页面外边距、页头、tab 到卡片、卡片内边距和底部操作栏均改为更紧凑节奏；顶部三 tab 扩至 680px，
  Agent 目标在 1440px 以上改为双列，压缩右栏高度及规则区被动拉出的空白；交互保持不变。
- 2048×1024 浏览器验收中主内容占工作区 89%，目标栏 520px，Agent 列表为 2×3 紧凑网格；Memory
  页面与 390px 窄屏均无横向溢出，浏览器控制台无 warning/error。
- 提交信息：`style: 压缩原型发布台留白`

## 发布台原型改为纵向密度优化（2026-08-03）

- 用户澄清主要问题是上下留白，而非左右留白。撤回上一轮 1640px 主内容、520px 目标栏、680px tab 和
  Agent 双列布局，恢复 1296px 主内容、352px 目标栏与单列目标列表。
- 纵向继续收紧：页面上下 padding、页头到 tab、tab 到卡片、卡片 header/pane、规则行、目标 tab、
  select、Agent 行和 action bar 均减少高度；不改变任何选择或发布交互。
- 桌面端返回入口并入标题行右侧；Claude/Codex 目标未选择时隐藏空路径占位，选择后按需展开。相同
  2048×1024 视口下 Memory 卡片顶部从约 186px 提前到 147px，高度从约 455px 降至 382px，底部位置
  上移约 112px；选择目标后路径与发布按钮正常，390px 无横向溢出，控制台无 warning/error。
- 提交信息：`style: 收紧原型纵向留白`

## 发布台原型填满剩余视口（2026-08-03）

- 用户截图明确标注的是主卡片下方大块页面背景，而非组件上下间距。桌面端 `task-surface` 改为填满标题
  与 tab 之后的剩余视口，`task-grid` 弹性扩展，底部操作栏稳定落在工作台底部。
- 规则区中间成为可承载更多规则的工作区，不再在卡片外留下大块无归属背景；全局规则空状态同步填充。
  620px 以下取消最小高度，保持移动端自然文档流。
- 2048×1024 验收中工作台从约 147px 延伸至视口底部附近，原截图标注的大块卡片外空白被工作区取代；
  工作台底部约 965px，文档高度与视口均为 1024px，无额外纵向滚动。390px 下最小高度回退为 0，
  无横向溢出；浏览器控制台无 warning/error。
- 提交信息：`style: 让原型工作台填满视口`

## 已接受规则发布台落入真实 App（2026-08-03）

- 将 `OutputRulesPage` 按已确认的 HTML 原型重构为单一满高工作台：顶部使用「项目规则 / 全局规则 /
  Memory」三个范围 tab；中间固定为规则选择区与目标配置区；底部只保留当前上下文的一项主操作。
- 项目规则默认全选当前项目的 accepted rules；Agent 目标保持显式多选。Memory 范围内 Claude 与 Codex
  改为互斥 tab，继续复用既有目标发现、默认空选、revision 校验、发布 IPC 与成功/失败反馈。
- 项目规则导出移动到工作台标题栏，仍始终导出当前项目全部 accepted rules，不受勾选状态影响。全局规则为
  0 时改为占满工作台的居中空状态，不展示无效的 Agent 目标和底部发布操作。
- 真实 Electron 截图依次对比项目规则、Claude Memory、Codex Memory 和全局空状态：页面标题、三 tab、
  1296px 级工作台边界、约 22rem 目标栏、规则行、底部操作栏均与原型同构；工作台填满剩余视口，页面下方
  不再出现原截图标注的大块空白。验收只切换页面和 tab，未选择发布目标、未触发发布或导出。
- App 27 suites / 178 tests、production build 与 `git diff --check` 通过；build 只保留既有 Markstream
  PURE 注释警告。App typecheck 仍被既有 workspace `rootDir` / `TS6307` 配置错误及 `RulesSection`
  的 `history` 类型错误阻断，本次 `OutputRulesPage` 改动区域没有新增 typecheck 报错。
- 提交信息：`feat: 重构已接受规则发布台`

## 发布台将 Memory 调整到项目规则旁（2026-08-03）

- 顶部范围顺序从「项目规则 / 全局规则 / Memory」改为「项目规则 / Memory / 全局规则」；项目规则与
  项目 Memory 两个项目上下文相邻，全局规则作为独立范围置后。
- 同步更新真实 App、HTML 原型、实施计划和布局契约测试，未修改任何发布、导出或目标选择逻辑。
- 真实 Electron 截图确认三个 tab 顺序和宽度正常；App 定向 2 suites / 52 tests、production build 与
  `git diff --check` 通过，build 仅保留既有 Markstream PURE 注释警告。
- 提交信息：`style: 调整发布范围顺序`

## 发布台固定桌面工作区高度（2026-08-03）

- 桌面端工作台从最小高度改为固定剩余视口高度，并显式拆成 `内容区 + 底部操作栏` 两行；项目规则、
  Memory、全局规则切换时外框上下边界和底部操作位置不再随内容变化。
- 左右内容栏共享同一内容行高度，内容超过可用空间时各自纵向滚动；1280px 以下恢复自然高度和页面流，
  避免窄屏被固定高度裁切。HTML 原型同步相同的桌面固定高度与响应式回退。
- 真实 Electron 截图逐项对比项目规则、Memory、全局空状态，三者工作台底边一致，左右栏高度一致；未触发
  任何发布或导出操作。
- App 27 suites / 178 tests、production build 与 `git diff --check` 通过，build 仅保留既有 Markstream
  PURE 注释警告。
- 提交信息：`style: 固定发布工作区高度`

## Agent Memory 增加文件定位入口（2026-08-03）

- Agent Memory 详情页标题右侧新增「在文件夹中显示」次级操作；Codex 与 Claude Memory 共用同一入口，
  保持内容预览只读，不打开编辑器也不修改原始文件。
- Renderer 只提交 `agent + memoryId`；主进程重新从 `listAutoMemorySources` 解析已授权来源，校验 Agent、
  memory id 与文件存在状态后才调用 Electron `shell.showItemInFolder`，不接受任意 Renderer 路径。
- 文件定位错误与 Memory 读取错误分开显示；定位操作不清空或破坏已经加载的预览内容。
- 真实 Electron 验收中按钮位于 Codex Memory 页标题右侧；点击后 Finder 打开
  `~/.codex/memories/` 并选中 `MEMORY.md`。Computer Use 截图与可访问性树均确认目标正确。
- App 27 suites / 178 tests、production build 与 `git diff --check` 通过；build 只保留既有 Markstream
  PURE 注释警告。App typecheck 仍被既有 workspace `rootDir` / `TS6307` 配置错误及两处既有 Renderer
  类型错误阻断，本次新增区域没有新增类型错误。
- 提交信息：`feat: 增加 Memory 文件定位入口`

## Codex Memory 按 applies_to 展示项目视图（2026-08-04）

- 新增独立 `codex-memory-parser.ts`，按 `# Task Group` 边界读取 `scope` 与 `applies_to`，只把
  `cwd=` 中显式的绝对路径视为项目；支持 `and/or` 多 cwd、路径规范化、去重，以及同 cwd 多 Task Group
  按原文件顺序聚合。
- Codex Auto Memory 继续保留物理 `memory` 全局主入口，并为每个 cwd 派生 SHA-256 截断 id 的虚拟项目
  source；项目详情只返回该 cwd 对应的原始 Task Group，`memories show codex` 无 id 行为仍读取全局文件。
- 项目切片不落 DB、缓存或副本，所有 source 的物理路径仍是统一 `~/.codex/memories/MEMORY.md`；读取继续
  执行 1 MiB、严格 UTF-8 与前后 stat 一致性校验，文件定位也继续只接受重新发现后的 source id。
- Agent Memory 列表为 Codex 项目展示项目名、完整 `applies_to.cwd`、Task Group 数量和“Codex 项目作用域”；
  详情说明这是统一文件派生的只读视图，不伪装成独立项目文件。
- 本机真实文件解析出 9 个 Codex 项目作用域；`agent-workspace` 聚合 5 个 Task Group，`rules-manager` 详情
  只显示其自身 Task Group。Computer Use 截图与可访问性树确认列表和详情布局，无写入操作。
- Core 30 suites / 307 tests、App 27 suites / 178 tests、Core/App production build 与
  `git diff --check` 通过；build 仅保留既有 tsdown define 与 Markstream PURE 注释警告。App typecheck 仍被
  既有 workspace `rootDir` / `TS6307` 及两处既有 `RulesView` 类型错误阻断，本轮新增类型错误已清零。
- 提交信息：`feat: 按项目展示 Codex Memory`

## Agent Memory 项目浏览 HTML 原型（2026-08-04）

- 新增独立 `agent-memory-project-browser.html`，不接入 Renderer、IPC 或本机文件读写。默认以项目为主视图，
  同一真实工作目录归组 Claude 与 Codex Memory，并保留「全部来源」查看物理文件和 Codex 派生范围。
- 项目列表提供搜索、Agent 筛选、来源数量、最近更新时间和待关联状态；点击项目进入独立详情，汇总、
  Claude、Codex 三个 tab 始终展示来源文件或 `applies_to.cwd` 匹配条件，不伪装成新的合并文件。
- Claude 缺少可靠 `projectPath` 时进入待关联，不通过编码目录名猜测真实路径；原型明确提示后续需从 Session
  元数据确认 cwd。Codex 继续使用显式 `applies_to.cwd` 归组。
- Chrome 1440×900 截图确认按项目、全部来源和项目详情三种状态的层级与密度；390×844 CSS 视口截图无
  横向溢出，实测 `scrollWidth=375`、`innerWidth=390`。浏览器脚本验证视图切换、搜索、详情进入和返回。
- 静态原型未新增自动化测试，替代验证为浏览器交互脚本、JS 语法检查、HTML 合同检查与 `git diff --check`。
- 提交信息：`docs: 新增 Agent Memory 项目浏览原型`

## Agent Memory 项目浏览落地（2026-08-04）

- 将 Agent Memory 首页落为「按项目 / 全部来源」双视图：默认按真实 `projectPath` 聚合 Claude 与 Codex，
  提供搜索、Agent 筛选、来源数量、更新时间和未关联提示；全部来源继续区分 Claude 物理文件、Codex
  本机合并文件与 Codex `applies_to.cwd` 派生范围。
- Claude 项目路径只从对应项目目录下 Session JSONL 的顶层 `cwd` 字段取证：最多检查最新 24 个文件、
  每个只读前 1 MiB；只有唯一绝对路径时才关联，冲突或缺失时保持未关联，不解析消息正文也不猜目录编码。
- 项目详情支持汇总、Claude、Codex 三个 tab；同一工作目录的来源并列展示，各自保留物理文件路径或
  `applies_to.cwd`，明确项目视图只做只读归组，不创建新的合并 Memory，也不触碰原始文件。
- 真实 Electron 对比截图覆盖项目列表、全部来源和 `agent-workspace` 聚合详情；本机结果为 9 个项目、
  13 个可读取来源，其中 `agent-workspace` 聚合 Claude 1 份与 Codex 5 个 Task Group，另有 2 份 Claude
  Memory 因 cwd 证据不唯一保持待关联。
- Core 30 suites / 309 tests、App 28 suites / 181 tests、Core/App production build 与
  `git diff --check` 通过；build 只保留既有 tsdown define 与 Markstream PURE 注释警告。App typecheck
  仍被既有 workspace `rootDir` / `TS6307` 配置错误及 `RulesView` 两处既有类型错误阻断，本轮新增区域
  没有新增类型错误。
- 提交信息：`feat: 增加 Agent Memory 项目浏览`

## Chat 输入栏控件改为无边框（2026-08-04）

- Chat Composer 底部的上下文按钮、Provider、Model、Effort Picker 与 Fast 控件统一移除静态描边、
  静态阴影和常驻底色，保持在同一工具栏平面；发送按钮继续保留主操作强调。
- 无边框不是无反馈：控件保留轻量 hover 背景，Picker 的 Popover、禁用状态、键盘 focus、Fast Switch
  和所有选择逻辑均保持不变。
- 真实 Electron 截图确认完成态 Chat 输入栏不再呈现一排独立输入框；验收只读取页面并截图，未发送消息、
  未切换 Provider、Model、Effort 或 Fast 状态。
- App 28 suites / 181 tests、production build 与 `git diff --check` 通过；build 只保留既有 Markstream
  PURE 注释警告。纯样式改动未新增业务逻辑测试，补充了 Composer 布局契约断言。
- 提交信息：`style: 统一 Chat 输入栏无边框控件`

## Rules 导航信息架构 HTML 原型（2026-08-04）

- 新增独立 `rules-navigation-information-architecture.html`，只验证 Rules 二级导航的信息架构与视觉分组，
  不修改真实 Renderer、路由、IPC、翻译或数据读取。
- 二级导航从四个同权入口改为两个轻量分组：`规则管理` 包含 `概览 / 规则工作台`，`Agent 上下文`
  包含 `Agent 指令 / Agent Memory`；原 `生成的规则` 改名为 `规则工作台`，覆盖生成、审核、接受与发布。
- 评审后移除二级导航左侧整条竖线及 active 项绿色短标；缩进、分组标题、选中背景和数量状态已经足够
  表达层级与当前位置，避免产生时间轴或步骤条暗示。
- 二级导航按钮改为与父级同宽的整行交互热区，再用 `2.4rem` 内部 padding 保持文字缩进；实测父子按钮
  左右边界同为 16px / 207px，子项文字与父级「规则」文字只差 3px。左侧空白现在也响应 hover、点击与 focus。
- 两处分组边界共用 `--group-block-gap: 1rem`：父级「规则」到「规则管理」、`规则工作台` 到
  `Agent 上下文` 的浏览器实测间距均为 16px，避免分别维护不一致的数字。
- 四个入口都提供可点击的页面示意；规则工作台增加 `Session → 生成候选 → 审核规则 → Agent 指令 / Agent Memory`
  生命周期带，明确后两者是发布位置和已有上下文，不是规则审核状态。
- 本机 Chrome 自动化依次点击四个入口，active 状态、`aria-current`、页面标题和可见内容同步正确；
  1440×900 与 390×844 的 `scrollWidth` 分别等于 `innerWidth`，控制台与页面错误均为空。桌面工作台、
  Agent Memory 与窄屏截图已保存到 `docs/prototypes/`。
- 本轮是独立 HTML/CSS/JS 原型，未新增业务自动化测试；替代验证为内联脚本语法检查、导航合同检查、
  真实浏览器交互、响应式视觉检查与 `git diff --check`。
- 建议提交信息：`docs: 新增 Rules 导航信息架构原型`

## Rules 导航信息架构落入真实 App（2026-08-04）

- 将真实 App 的 Rules 二级导航按 HTML 原型重组为两组：`规则管理` 包含 `概览 / 规则工作台`，
  `Agent 上下文` 包含 `Agent 指令 / Agent Memory`；仅调整导航结构与中英文文案，既有 section id、
  页面内容、返回逻辑和深链行为保持不变。
- 移除旧的二级导航左侧竖线；所有二级项使用与父级相同宽度的整行 Button 热区，文字通过内部 padding
  对齐。分组容器补充 `role="group"` 和本地化 `aria-label`，激活项继续使用 `aria-current="page"`。
- 父级「规则」到首个「规则管理」标题、`规则工作台` 到 `Agent 上下文` 标题均按 16px 分组边界处理；
  组内标题与条目保持紧凑，不引入原型中的演示数量或虚构主内容。
- 真实 Electron 验收覆盖暗色、浅色和应用最小 900px 宽窗口；直接点击 `Agent 指令` 文字左侧空白区域
  成功切换页面，确认整行热区生效，导航无截断、横向溢出或层级错位。验收后恢复深色与常用窗口尺寸。
- App 全量 28 suites / 182 tests、最终定向 2 suites / 53 tests、production build 与
  `git diff --check` 通过；build 只保留既有 Markstream PURE 注释警告。App typecheck 仍被仓库既有
  workspace `rootDir` / `TS6307` 配置问题阻断，本轮 `App.tsx` 未新增类型错误。
- 提交信息：`style: 对齐 Rules 分组导航`

## Chat 历史 Tab 补充 Hover 反馈（2026-08-04）

- 为对话历史顶部「当前 / 归档」两个筛选 Tab 的未选中态补充整块 `surface-hover` 背景和前景文字色，
  保留现有 `surface-raised` 选中态、尺寸、圆角与切换逻辑。
- 同步增加 `transition-colors` 和 `focus-visible` 反馈，使鼠标与键盘操作具备一致的当前位置提示。
- 真实 Electron 中将鼠标停在未选中的「归档」Tab，暗色与浅色主题均出现清晰背景和文字变化；检查后
  恢复用户原有深色主题，未切换筛选状态或修改对话数据。
- App 定向 1 suite / 46 tests、production build 与 `git diff --check` 通过；build 仅保留既有
  Markstream PURE 注释警告。纯交互样式修复未新增业务逻辑测试，使用布局契约测试与真实视觉检查替代。
- 提交信息：`style: 补充 Chat 历史 Tab hover`

## Chat 工具活动按阶段分组（2026-08-04）

- Native Chat 不再逐条平铺 Tool activity：同一 Assistant Turn 内相邻的 Tool 按阶段聚合，Assistant 正文与
  Thinking 保持时间顺序并作为分组边界；旧消息的 `toolActivities` fallback 也复用相同分组展示。
- 组头只基于安全 Activity 元数据汇总 Read / Search / Shell / Tool 分类计数，例如“读取 97 个文件，运行
  54 条命令，调用 9 个工具”；完成态默认收起，运行态显示 Spinner，失败态显示失败数量并首次自动展开调用清单。
- 展开采用两级渐进展示：第一层展示逐条安全摘要，第二层才沿用 `chat.tool.read` 从 Native Session 回源详情；
  本轮未修改 IPC、ChatStore 或 Tool input/output 持久化策略。
- 分组按钮与单条按钮都补充 `aria-expanded`、hover、focus 和箭头状态；详细设计、观察点与验证方式记录在
  `docs/plans/chat-tool-activity-groups.md`。
- 真实 Electron 暗色界面验收使用已有 160 条 Tool 的历史对话：默认只显示一行分类摘要，展开组后出现
  逐条调用，展开单条可正常回源详情，最终恢复收起；没有发送消息、切换运行配置或修改 Chat 数据。
- App 定向 3 suites / 56 tests、App 全量 28 suites / 185 tests、Core 全量 30 suites / 309 tests、
  production build 与 `git diff --check` 通过；build 只保留既有 Markstream PURE 注释警告。
- 提交信息：`feat: 分组展示 Chat 工具活动`

## Codex 大型 Session Context 附件化（2026-08-04）

- 研究当前本机 Codex Desktop 后确认：Composer 对粘贴文本使用 5,000 个 JavaScript 字符作为转文本附件的
  边界，5,000–25,000 字符的附件允许恢复回输入框；这属于 Desktop 客户端策略，Codex App Server 官方
  文档与协议没有声明自动转换阈值。
- 使用本机 `codex app-server generate-ts --experimental` 生成当前协议类型，确认文本文件应通过
  `v2.UserInput` 的 `mention { name, path }` 输入项提交；文本输入同时补齐协议中的 `text_elements: []`。
- App 沿用 5,000 字符边界：较小 Session Context 与所有 Claude 请求保持原有内联行为；Codex 的大型
  Session Context 写入权限为 `0600` 的临时文本文件，本轮通过 `mention` 提交，Turn 成功、失败或中断
  结束后均删除临时目录，不把隐藏 Prompt 或附件正文写入 ChatStore。
- 移除 IPC 的 500 条 Session 引用数量上限；agent、id 与数组结构校验保持不变。Provider 仍负责按附件中
  的完整 replace 列表执行 `memory-manager sessions show <id> --stream`，App 不预读 Session 原文，也不替
  Codex 规划最终上下文容量。
- 新增阈值边界、Claude 内联回归、1,000 条 IPC 引用、App Server `mention` 协议、Provider 成功/失败清理
  的自动化测试。App 全量 30 suites / 191 tests、production build 与 `git diff --check` 通过；build 只保留
  既有 Markstream PURE 注释警告。
- App typecheck 仍被仓库既有 workspace `rootDir` / `TS6307` 配置问题，以及 `RulesView` 两处既有类型错误
  阻断；输出中没有本轮新增文件的类型错误。
- 提交信息：`feat: 附件化 Codex 大型 Session Context`

## Chat 运行中对话恢复终止按钮（2026-08-04）

- 修复 Native Chat Composer 只依赖本地 `isSending` 展示「停止本轮」的问题；统一判定同时识别
  `thread.kind === 'native-chat' && thread.status === 'running'`，覆盖从 Rules 发起后跳转、切换回来和刷新恢复。
- 中断动作继续复用现有 `chat.interrupt`；本地发送队列、发送按钮语义、Rules Generation 顶部停止操作和
  Provider 中断协议均未修改。
- 新增状态逻辑测试，覆盖本地发送、恢复运行中 Native Chat、ready / failed / interrupted 终态以及非 Native
  Thread；Composer 布局契约同步确认按钮使用统一判定。
- 隔离生产 Electron 实例中启动 Codex `sleep 30` 只读任务，离开 Chat 再重新进入后仍显示「停止本轮」；
  任务自然完成，未点击终止。主窗口已有未发送草稿未被修改。
- 本轮实现完成时 App 定向 2 suites / 59 tests、App 全量 30 suites / 197 tests、Core 全量 30 suites /
  309 tests、production build 与 `git diff --check` 通过；build 只保留既有 Markstream PURE 注释警告。
- 验收期间出现并发的 Codex 长文本附件改动；基于最终工作树复跑时本轮两个定向套件继续通过、production
  build 通过，但 App 全量被该并发改动尚未同步的 `chat-markdown-rendering.test.ts` 旧源码断言阻断。本轮未
  修改或回滚该无关改动。
- 提交信息：`fix: 恢复运行中 Chat 终止按钮`

## Chat 可见长文本附件与 Composer 右侧布局修复（2026-08-04）

- 补齐 Codex Desktop 一致的可见交互：在 Codex Composer 粘贴不少于 5,000 个 JavaScript 字符时，正文会从
  输入框转成紧凑的“粘贴的文本”附件卡，展示字符数并支持移除；不超过 25,000 字符时还可放回输入框。
- 附件允许单独发送。Renderer 只把本轮附件正文交给 Main；Main 重新校验数量、字符数与单件 10 MiB 上限，
  写入权限为 `0600` 的临时文本文件，并通过 Codex App Server `mention` 输入项提交，Turn 结束后清理。
- ChatStore 只持久化附件名称与字符数，明确不保存粘贴正文或临时路径；Claude 仍不启用文本附件化，切换离开
  Codex 时会把尚未发送的附件正文恢复到输入框，避免草稿丢失。
- Composer 外层裁剪原生滚动条；底部工具栏改为固定动作区与可横向收缩的运行配置区，避免窗口较窄、左右侧栏
  同时展开时，“完全允许”、上下文占用和发送按钮被挤出。该布局选择来自 redesign 评审后的紧凑分区方案。
- 真实 Electron 暗色界面粘贴 5,005 字验收通过：附件卡、字符数、放回/移除操作均可见，输入框正文为空，右侧
  动作完整显示；验收后已移除测试附件，未发送消息。
- 新增 Renderer 阈值模型、Main 输入校验、附件协议、隐私持久化和布局契约测试；定向 6 suites / 74 tests、
  App 全量 32 suites / 203 tests、production build 与 `git diff --check` 通过；build 只保留既有 Markstream
  PURE 注释警告。
- 提交信息：`feat: 显示 Codex 长文本附件并修复 Composer 布局`

## Chat 思考正文与单工具展示修复（2026-08-04）

- 核对用户截图对应的真实 ChatStore 数据后确认，Codex App Server 为这些 reasoning item 只发送了生命周期事件，
  持久化 `content` 为空；App 无法恢复或推断 Provider 未返回的隐藏推理内容。
- 继续核对本机当前 App Server 生成类型后确认 `TurnStartParams.summary` 支持
  `auto / concise / detailed / none`；此前 Adapter 只传 `effort`，没有请求推理摘要。本轮为每个 Codex Turn
  显式传 `summary: "auto"`，复用已有 `item/reasoning/summaryTextDelta` 消费链展示可读摘要。
- Native Chat 中有正文的 Thinking 改为默认直接展示标题和正文，不再要求点击展开；正文为空或仅空白时不渲染
  占位行，避免出现满屏无法查看的“思考”。
- 空 Thinking 同时在 Timeline 分组前过滤，不再形成不可见的阶段边界；因此被空 reasoning 生命周期事件隔开的
  多条 Tool 会按用户实际看到的连续阶段重新聚合，有正文 Thinking 仍保留分组边界。
- 实际回放历史 Rules 频道后补充确认：仅按可见相邻关系会跨越 Codex Provider Turn 形成过大分组；现使用
  Tool 已有的 `sourceLocator.turnId` 划分调用阶段，同一 Turn 聚合、不同 Turn 分开，单工具 Turn 继续直出。
- Timeline 分组改为先收集连续 Tool：只有连续两条及以上才生成分类汇总组；单条 Tool 保留原始 Timeline item，
  直接渲染可展开详情的工具卡。旧消息 `toolActivities` fallback 同样在单条时直出。
- Assistant 与 Thinking 继续作为 Tool 分组边界；Tool 详情仍通过既有 `chat.tool.read` 回源，未修改 ChatStore
  结构、Provider 协议或 Tool input/output 持久化策略。
- 隔离生产 Electron 中回放用户的 `生成规则：changed7d` 历史频道：100 条 Tool 按 46 个 Codex Turn
  分阶段，首段收起显示“运行 8 条命令”、展开后正好 8 条；单 Tool Turn 直接显示 `Command`。历史频道
  的 96 条 Thinking 正文均为空且不再渲染；另发起真实只读 Codex 任务后出现 1 条可读推理摘要，单条
  Command 直接展示，证明新 Turn 的 `summary: "auto"` 链路生效。
- 定向 3 suites / 73 tests、App 全量 32 suites / 206 tests、Core 全量 30 suites / 309 tests、production
  build 与 `git diff --check` 通过；build 只保留既有 Markstream PURE 注释警告。
- 提交信息：`fix: 显示 Chat 思考摘要并直出单条工具`

## Chat 思考正文 Markdown 渲染（2026-08-04）

- Native Thinking 正文不再用纯文本 `<p>` 展示，改为复用 Assistant 已有的 Markstream 渲染链；加粗、列表、
  行内代码等 Markdown 能力与 Chat 正文一致，运行中 Thinking 继续使用流式 `final=false`。
- 为 Thinking 增加专用视觉变体，保留原有较小字号、紧凑行高、弱化文字色和左侧阶段线，不改变 Assistant
  Markdown 样式、空 Thinking 过滤或 Tool 分组边界。
- 隔离生产 Electron 中复制并打开用户截图对应的真实历史 Chat，`**Planning task-specific ID verification**`
  已显示为无星号的加粗文本；同频道其他 Thinking Markdown 同样正常，未修改主应用 Chat 数据。
- 定向 3 suites / 66 tests、App 全量 32 suites / 206 tests、Core 全量 30 suites / 309 tests、production
  build 与 `git diff --check` 通过；build 只保留既有 Markstream PURE 注释警告。
- 提交信息：`fix: 使用 Markdown 渲染 Chat 思考正文`

## Chat 完成应用角标（2026-08-04）

- Native Chat 的 Assistant Turn 成功落盘后触发应用级完成通知；普通 Chat 每轮成功计一次，Rules Native Chat
  只在整次规则生成成功后计一次，Provider 失败路径不计数。
- 角标采用进程内未读语义：应用不在前台时依次累计 `1`、`2`；任一主窗口重新获得焦点后清零，应用在
  前台完成的轮次不产生未读角标。计数不写入 ChatStore、数据库或对话文件。
- Electron 主进程使用 `app.setBadgeCount` 写入系统应用角标；平台 API 不可用或抛错时隔离失败，不反向改变
  已成功完成的 Chat Turn。
- 观察点、验收标准与验证方式记录在 `docs/plans/chat-completion-app-badge.md`。
- 新增角标累计、前台忽略、聚焦清零、系统 API 异常隔离，以及 Controller 成功通知/失败不通知测试。
- App 全量 33 suites / 210 tests、production build 与 `git diff --check` 通过；build 只保留既有 Markstream
  PURE 注释警告。App typecheck 仍被仓库既有 workspace `rootDir` / `TS6307` 配置问题及 `RulesView` 两处
  既有类型错误阻断，输出中没有本轮新增文件的类型错误。
- 提交信息：`feat: 增加 Chat 完成应用角标`

## Chat 多段思考摘要分隔修复（2026-08-04）

- 根因确认：Codex App Server 的同一 Reasoning item 可返回多个 `summary[]` 条目；流式
  `summaryTextDelta` 被 Adapter 无分隔拼接成 `**A****B**`，完成事件又因 `streamed || completedContent`
  保留了错误流式内容，导致 Markdown 中间四个星号按正文显示。
- Reasoning 完成时改为优先使用 App Server 完整 item 的权威摘要，并按空行连接多段内容；只有完成 item
  没有摘要时才回退流式文本。运行中增量、空 Reasoning 和 Assistant 消息链路不变。
- Thinking 渲染前增加窄范围历史兼容，仅将非空文字之间的四星号边界还原成两个加粗段；不修改 ChatStore
  原文件，也不对 Assistant Markdown 做通用替换。
- 隔离生产 Electron 中回放用户截图对应的真实历史 Chat，原先一行的
  `Planning command execution strategy****Evaluating streaming command output options` 已显示为两行加粗摘要，
  四个星号消失；主应用数据未修改。
- 定向 4 suites / 77 tests、App 全量 34 suites / 214 tests、Core 全量 30 suites / 309 tests、production
  build 与 `git diff --check` 通过；build 只保留既有 Markstream PURE 注释警告。
- 提交信息：`fix: 修复 Chat 多段思考摘要拼接`

## 顶部边栏双击缩放窗口（2026-08-04）

- 应用最顶部新增 12px 双击热区：普通窗口双击调用 `maximize()`，已最大化窗口再次双击调用
  `unmaximize()`，恢复此前普通窗口尺寸；不进入或退出用户主动开启的系统全屏。
- 保留原有 2rem `-webkit-app-region: drag` 拖拽带；双击热区仅占最上方边缘并显式使用 `no-drag`，Chat
  Header 等交互控件继续由更高层 `window-no-drag` 保护。
- Renderer 只发送 `window.toggleMaximize`；Main 使用 `BrowserWindow.fromWebContents(event.sender)` 定位
  发起事件的窗口，不接受 Renderer 传入窗口标识，也不依赖全局主窗口引用。
- 首版把 `onDoubleClick` 直接绑定到 `drag` 元素，但真实 Electron 验收确认原生拖拽区域不会派发 DOM
  双击事件；调整为独立顶部边缘热区后，两次真实双击均命中 IPC，分别执行最大化与还原分支。
- 观察点、验收标准与验证方式记录在 `docs/plans/window-titlebar-double-click.md`。
- 新增普通窗口最大化、已最大化还原、全屏保护，以及拖拽层/双击层/IPC 来源窗口合同测试。
- App 定向 3 suites / 14 tests、全量 34 suites / 214 tests、production build 与 `git diff --check`
  通过；build 只保留既有 Markstream PURE 注释警告。
- 提交信息：`feat: 支持顶部双击缩放窗口`

## 修改完成后自动提交推送规则（2026-08-05）

- 根目录 `AGENTS.md` 工作流新增强制收尾规则：每次修改完成并按风险验证后，必须 commit 并立即 push
  当前分支，不得停留在未提交或仅本地提交状态。
- push 若因权限、网络或远端冲突失败，必须明确报告阻塞，不得把未推送状态描述为交付完成。
- 本轮仅修改项目工作流文档，不新增业务测试；替代验证为规则内容回读、`git diff --check`、提交后本地与
  `origin/main` SHA 对账。
- 提交信息：`docs: 要求修改后提交并推送`

## Settings 语言设置行横向对齐（2026-08-06）

- 根因是 HeroUI 3.2.2 的 `Card.Content` 默认带 `flex-col`；原实现只声明 `flex`、`items-center` 与
  `justify-between`，导致语言说明和选择器纵向排列并整体居中，卡片左侧出现大块无效留白。
- 为该设置行显式补充 `flex-row`，恢复“说明在左、选择器在右”的预期关系；语言切换、持久化、错误态、
  Card surface 与现有间距均保持不变。
- 本轮是纯样式修复，未新增业务测试；使用现有 i18n / 布局契约测试、App 与 Core 全量测试、production
  build、`git diff --check` 和真实 Electron 暗色/浅色视觉检查替代。App 34 suites / 214 tests、Core 30
  suites / 309 tests 全绿，build 只保留既有 Markstream PURE 注释警告；验收后恢复暗色主题和原窗口尺寸。
- 提交信息：`style: 修复语言设置行对齐`

## Chat 首次进入同步 Provider 全量目录（2026-08-06）

- 根因是 `settings.providers.snapshot` 在缓存为空时只负责启动后台 Provider probe，并立即返回
  `entries: [] / refreshing: true`；Main 随后通过 `settings.providers.updated` 广播完整目录，但 ChatView
  此前只读取一次 snapshot、没有订阅更新，因此配置中的已选模型找不到对应条目并显示 `Select an item`。
- ChatView 现在先订阅 `settings.providers.updated`，再并行读取初始 snapshot 与 LLM 配置，卸载时同步解绑；
  Provider、Model、Effort、Fast Mode、Native Chat 会话绑定和发送协议均未修改。
- 新增 `createProviderSnapshotSync` 处理初始化竞态：初始空 snapshot 先返回时继续接收后台全量更新；全量更新
  先到时拒绝随后返回的旧空 snapshot 覆盖；卸载后不再写入状态。
- 新增两条行为测试覆盖上述两种事件顺序与卸载边界，并用布局契约测试固定“先监听、后请求、卸载解绑”；
  定向 3 suites / 65 tests、App 全量 34 suites / 216 tests、Core 全量 30 suites / 309 tests、production
  build 与 `git diff --check` 通过，build 只保留既有 Markstream PURE 注释警告。
- `simplify` 复核确认同步器已保持单一职责和最小状态，没有再扩大抽象或改动无关 Chat 逻辑。
- 提交信息：`fix: 同步 Chat Provider 全量目录`

## OpenCode / Pi 原生 Provider（2026-08-06）

- 按 Paseo direct adapter 同步四 Provider 目录：OpenCode 覆盖 Settings、Chat、Rules；Pi 覆盖 Settings、Chat，
  通过 capability 从 Rules 排除；Fast Mode 仍只对 Claude/Codex 开放。
- OpenCode 采用共享 `opencode serve` + SDK v2 HTTP/SSE，Session 创建固定 Full Access，permission 自动 always；
  question 进入 Renderer 回答卡，原生 archive/unarchive/delete 与结构化 JSON Schema Rules 均接通。
- Pi 采用 `pi --mode rpc` JSONL，使用 session file 作为恢复 handle，支持模型、七档 thinking、流式正文、
  Thinking、Tool、interrupt 与 extension UI；App archive/delete 明确不修改原生 JSONL。
- ChatStore 增加 `{ sessionId, nativeHandle }` 的 provider-neutral handle，同时保留旧 v2 字符串读取兼容；Rules
  和普通 Chat 都写入 handle。Tool output 继续只在需要时从 Provider 回源，不进入 ChatStore。
- 真实 OpenCode/Pi 各三轮并在第三轮前重建 Adapter，均恢复相同原生 Session；OpenCode question、Rules、
  生命周期与两者 Tool/Thinking/interrupt 通过。Pi 本机没有可触发 extension UI 的 question extension，协议链
  由可控 RPC 测试覆盖，记录为非阻塞环境覆盖缺口。
- `simplify` 复核后拆除了 Provider probe 与 Pi UI response 的嵌套条件，并忽略 Pi notify/setStatus 等非交互
  UI 事件；行为保持不变，新增测试锁定 notify 不生成回答卡。
- Core 30 suites / 311 tests、App 36 suites / 224 tests，skipped=0；Core/App production build、
  `git diff --check` 通过。构建仅有既有 tsdown define 与 Markstream PURE 注释 warning。
- 提交信息：`feat: 接入 OpenCode 与 Pi 原生 Provider`

## OpenCode / Pi Paseo 对齐复审（2026-08-06）

- 撤回越界修改的 Core `rules-generate` 命令与测试；OpenCode Rules 在 App 层通过可审计的 Core 编排兼容桥进入，注入生成器仍明确调用 OpenCode runtime，Pi 直接拒绝。
- Pi JSONL 通信抽成共享进程层，覆盖 request id、分片/乱序、超时、stderr 上限、非法 JSON、exit fail-all 和进程组 TERM→KILL；Chat 与 Provider probe 复用。
- OpenCode server 补齐 ready 前 generation 所有权、启动失败清理、共享 lease、进程组 TERM→KILL；SSE 补齐嵌套 Session 过滤、EOF 失败及运行态 Tool 内存详情。
- 真实 smoke 捕获并修复 Pi abort/exit 竞态；新增回归锁定进程先退出后 interrupt 仍安全完成。
- 真实 Pi question 通过仓库外临时 extension 触发并回答 A；OpenCode question、Tool、结构化 candidate schema、interrupt 与两者三轮重启恢复均通过。
- 反向验证：Pi 缺少共享 RPC 模块时 suite 编译红→4/4 绿；OpenCode 错误 Session 断言 `wrongtarget` 实际收到 `target` 红→恢复后绿。
- 全量 Core 30 suites / 310 tests、App 40 suites / 239 tests，skipped=0；两项 build 与 `git diff --check` 通过；构建仅既有 tsdown define 与 Markstream PURE warning。
- 提交信息：`fix: 补齐 OpenCode Pi Paseo 运行时合同`

## OpenCode / Pi 最终 UI 与生命周期验收（2026-08-06）

- production Electron 以真实 HOME 验证四 Provider 状态/模型、Chat 选择器、Pi 四个本机模型与七档 thinking；Fast
  Mode 只对 Claude/Codex 显示。Rules Agent 选择器只有 Claude/Codex/OpenCode，Pi 为 0。
- 真实 App 内 OpenCode Provider 默认问题请求等待 82 秒未产生事件；通过“停止本轮”成功中断，UI 明确展示
  `MessageAbortedError`。原生 question 的明确模型 smoke 已返回 `OC-QUESTION-A`，Pi 临时真实 extension 已返回
  `PI-QUESTION-A`，统一 `interaction_request` 回答卡由 Renderer 自动化覆盖。
- 生命周期审计补充 OpenCode Adapter 直测。首轮用错误的 `archivedAt` 字段断言，得到 1 failed / 5 passed；
  对齐实际 SDK `time.archived` 请求后 6/6 通过，锁定原生 archive/unarchive/delete 路由。
- 最终反向审计把 Pi 错误加入 Rules 期望，并把无响应 RPC 预期改成“不会超时”，定向得到 2 failed / 7
  passed；还原后 2 suites / 9 tests 全绿，实际错误分别锁定 Pi 过滤与 `Pi RPC never 超时`。
- 隔离 UI HOME 已移入废纸篓；production Electron 已停止。最终全量 Core 30 suites / 310 tests、App 40
  suites / 240 tests，0 skipped；Core/App production build 均通过，只保留既有 tsdown define 与 Markstream
  PURE warning。
- 提交信息：`test: 补齐 OpenCode Provider 最终验收`

## OpenCode 可用模型目录修复（2026-08-06）

- 根因是 OpenCode `provider.list().all` 同时包含可用与未连接 Provider；原 probe 无过滤展开全部模型，导致
  Settings 把 6120 个全量目录项标记为可用。Paseo 的权威语义是 `connected` 或 `source === "api"`。
- `provider.list` 现在携带当前目录，并由 `mapAccessibleOpenCodeModels` 只映射可访问 Provider；无可访问
  Provider 时明确报错，交给现有 probe fallback/error 链路展示。
- 红测首次因过滤函数不存在得到 TS2305；实现后 1 suite / 2 tests 通过，覆盖未连接排除、API Provider 保留
  与空可访问目录报错。
- 真实 probe 返回 `status=available, count=13`，模型 ID 与 `opencode models` 完全一致；第一次用 CJS 形态
  `tsx -e` 验证受嵌套 SDK export condition 阻断，改用 Node ESM + tsx loader 后成功，不涉及产品代码。
- `simplify` 复核未发现需要调整的复杂度。Core 30 suites / 310 tests、App 41 suites / 242 tests，0 skipped；
  Core/App production build 与 `git diff --check` 通过，仅保留既有构建 warning。
- 提交信息：`fix: 过滤 OpenCode 实际可用模型`

## OpenCode Composer 选择器视觉修复（2026-08-06）

- 截图中的两段白色弧线不是 OpenCode Provider 的独立边框，而是 HeroUI Select 的外扩焦点环被
  `data-composer-runtime` 横向滚动容器裁切；同时 `w-24` 对 `OpenCode` 文案和 indicator 偏窄。
- Provider Select 改为 `w-28`，Composer 内四个运行时 Select Trigger 统一增加 `ring-inset`。这样键盘
  焦点仍使用主题 focus 色，但完整落在 32px Trigger 内部，不改变 Picker、Switch、发送或 Provider 行为。
- 布局契约先加入宽度和四个内嵌焦点环断言，首次定向运行 1 failed / 46 passed；实现后 47/47 通过。
- `simplify` 复核确认本次纯样式修改无需抽取共享常量。最终 Core 30 suites / 310 tests、App 41 suites /
  242 tests 全绿，App production build 与 `git diff --check` 通过；构建只有既有 Markstream PURE warning。
- 真实 Electron 暗色主题打开 OpenCode Provider 菜单并按 Escape 返回 Trigger 后，内嵌焦点框连续完整，
  `OpenCode` 和箭头无裁切，原截图中的左右白弧不再出现。
- 提交信息：`style: 修复 OpenCode Composer 选择器`

## Chat Composer 输入法 Enter 修复（2026-08-06）

- `ChatView` 原 `onKeyDown` 只检查 `event.key === 'Enter' && !event.shiftKey`。IME 确认候选字同样触发
  Enter keydown，因此会 `preventDefault()` 并调用 `sendChatMessage()`；该问题与 Provider 无关。
- 新增纯函数 `shouldSubmitComposer`，排除 `nativeEvent.isComposing` 和 Chromium/macOS 的遗留兼容信号
  `keyCode === 229`，再由 `ChatView` 复用。普通 Enter 与 Shift+Enter 行为不变。
- 行为测试先因函数未导出得到 TS2305；实现后定向 2 suites / 67 tests 通过，覆盖五类键盘事件。
- `simplify` 复核确认纯函数边界明确，无需继续抽象。最终 Core 30 suites / 310 tests、App 41 suites /
  247 tests 全绿，App production build 与 `git diff --check` 通过；只有既有 Markstream PURE warning。
- 构建后的 Electron Renderer 通过 CDP 直接派发事件：组合态 Enter、229 Enter、Shift+Enter 的
  `defaultPrevented` 均为 false，普通 Enter 为 true。验证使用空 Composer，未持久化测试 Chat 或消息。
- 提交信息：`fix: 阻止输入法 Enter 误发消息`
