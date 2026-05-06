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
