# memory-manager · 项目规则

## 项目本质

本地优先 AI agent session 管理 CLI。扫描 4 个 agent（claude / codex / copilot / cursor）的本地 jsonl session，聚合成 project 归类，后续用于生成 rule 文件。当前进度：Plan 04 已落（共 8 plan，见 [docs/plans/](docs/plans/)）。

## 红线

- 不存对话原文 / tool output / LLM prompt —— DB 只存指纹（content_hash）+ 元数据（cwd / gitRoot / branch）+ 路径引用（source_path）
- `project_hints.value` 只允许路径 / repo / branch 文本，**禁止**对话片段
- scanner 错误不能静默吞 —— 用 `errorLog` 写入 `run_metadata.details`
- schema 加列必须走 `addColumnIfMissing` 守卫（仅吞 `duplicate column name`，其他错抛出）
- adapter 接口扩展走**非破坏式**：保留旧方法，新增 `parse / normalize / extractProjectHints`

## 工作流

1. 接续工作前必读 [memory/process.md](memory/process.md) 末尾段（Plan/Round 决策 + 留作 debt）
2. 实现新 plan/round：先在 [docs/plans/](docs/plans/) 落"观察点 + 验证方式"
3. 完成一段实现：`memory/process.md` 追加 → `npm test` 全绿 → commit
4. Commit 信息按 `memory/process.md` 末尾"提交信息"段格式

## 命令

| 操作 | 命令 |
|---|---|
| 构建 | `npm run build`（产物 `dist/cli.js`） |
| 测试 | `npm test`（ESM Jest，已配 `--experimental-vm-modules`） |
| 跑 CLI | `node dist/cli.js <cmd>` |
| CLI 命令清单 | `init / status / scan [--all] [--source <dir>] [--agent <name>] / projects {list,assign,merge,reclassify}` |

## DB / 状态

- 单文件：`<workspace>/.memory-manager/memory.db` + `-shm` + `-wal`（WAL 模式）
- 默认 workspace：`~/.memory-manager/`；隔离测试用 `HOME=$(pwd)/.scratch`
- Schema 当前 **v4**（`schema_meta.value`）；表清单：`sessions / projects / session_projects / project_hints / rule_candidates / run_metadata / schema_meta`
- 升级路径：v1→v2→v3→v4，迁移函数在 [src/db.ts](src/db.ts)

### GUI 工具

推荐 **TablePlus**（macOS 原生，免费版够用）：

```bash
brew install --cask tableplus
open -a TablePlus <workspace>/.memory-manager/memory.db
```

备选：DB Browser for SQLite、DBeaver Community。

**WAL 注意**：

- `memory.db` 必须和 `-shm` / `-wal` 一起出现 —— 拷贝时三件套，否则丢未 checkpoint 写入
- GUI 打开**不要选 read-only 模式**，否则可能看不到 pending 数据
- 命令行兜底查询：

```bash
node -e "const db=new(require('better-sqlite3'))('<path>/memory.db',{readonly:true}); \
console.log(db.prepare('SELECT * FROM projects LIMIT 5').all())"
```

## 本机真实环境扫描（隔离工作区）

```bash
SCRATCH="$(pwd)/.scratch" && rm -rf "$SCRATCH" && mkdir -p "$SCRATCH"
HOME="$SCRATCH" node dist/cli.js init --yes
mkdir -p "$SCRATCH/.memory-manager/sources"
for a in claude codex copilot cursor; do
  ln -sfn ~/.$a "$SCRATCH/.memory-manager/sources/$a"
done
HOME="$SCRATCH" node dist/cli.js scan --all
HOME="$SCRATCH" node dist/cli.js projects list
```

`.scratch/` 已 .gitignore，不污染默认 home。

## 目录结构

```
src/
  cli.ts                 Commander 入口（命令注册）
  commands/              命令实现层（init / scan / projects）
  adapters/{claude,codex,copilot,cursor}.ts  4 内置 adapter
  adapters/shared.ts     fileHash / readJsonlObjects / defaultNormalize
  scanner.ts             discover → parse → normalize → 写库 + 归类
  classifier.ts          hint → projectKey + confidence
  projects.ts            数据层（assignSession / mergeProjects / reclassifyAll / rebuildProjectsSummary）
  db.ts                  schema + 迁移
  workspace.ts           工作区路径解析
test/
  unit/                  Jest 测试（125+ tests），新测试走 mkdtempSync 临时 fixture
  sources/{claude,codex,copilot,cursor}/  真实 fixture，禁改（plan 04 验收依赖）
docs/plans/{01-08}-*.md  8 个阶段计划
docs/specs/              spec
memory/process.md        实现决策上下文，每段完成后追加
```

## 改动前必查的项目特有约束

- `normalize` **不重算** id / contentHash，复用 discover；仅权威化 updatedAt
- `sessions.updated_at` 必须写 `discover.updatedAt`（不是 `normalize.updatedAt`）—— 否则 unchanged 判定永远失效，process.md R3a 踩坑过
- 新加测试用 `mkdtempSync` 临时 fixture，**禁止改** `test/sources/<agent>/`（影响 plan 04 验收的 4 个 fixture 项目名）
- ESM Jest：`import { jest } from '@jest/globals'`，全局 `jest` 不可用
- adapter `extractProjectHints` 输出只能基于 metadata 或文件路径，**禁止**把对话内容写进 `hint.value`

## 按需查的上下文

| 触发 | 读什么 |
|---|---|
| 接续工作 / 不确定上一段进度 | [memory/process.md](memory/process.md) 末尾段 |
| 开始下一个 plan | `docs/plans/<N>-*.md` |
| 怀疑 adapter 行为 | `test/sources/<agent>/` + `test/unit/adapter-*.test.ts` |
| 改 schema | [src/db.ts](src/db.ts) 现有 `migrateV*To*` + `addColumnIfMissing` 守卫 |
| spec 对账 | [docs/specs/memory-manager-spec.md](docs/specs/memory-manager-spec.md) |
