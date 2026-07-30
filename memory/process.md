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
