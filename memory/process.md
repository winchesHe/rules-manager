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

## 提交信息

实际：
```
fix: 修复 Plan 02 review 发现的 --full / missing 重复计数 / 分类测试缺口
feat: Plan 03 Round 1 — probe + extractProjectHints 接口与 4 adapter 实现
```
