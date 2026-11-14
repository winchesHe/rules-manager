# memory-manager · 项目规则

## 项目本质

本地优先 AI agent session 管理 CLI。扫描 8 个 agent（claude / codex / copilot / cursor / gemini / grok / opencode / pi）的本地 session，聚合成 project 归类，后续用于生成 rule 文件。OpenCode 的权威来源是 SQLite，其余主要是 JSONL/YAML。当前进度：Plan 04 已落（共 8 个基础计划，见 [docs/plans/](docs/plans/)）；扩展 Agent 适配记录见 [Grok Build 与 Gemini CLI Session 适配器](docs/plans/grok-gemini-session-adapters.md)。

## 红线

- 不存对话原文 / tool output / LLM prompt —— DB 只存指纹（content_hash）+ 元数据（cwd / gitRoot / branch）+ 路径引用（source_path）
- adapter `extractProjectHints` 抽的 `hint.value` 只允许路径 / repo / branch 文本，**禁止**对话片段（hints 不入库，只用于即时分类）
- scanner 错误不能静默吞 —— 用 `errorLog` 写入 `run_metadata.details`
- schema 加列必须走 `addColumnIfMissing` 守卫（仅吞 `duplicate column name`，其他错抛出）
- adapter 接口扩展走**非破坏式**：保留旧方法，新增 `parse / normalize / extractProjectHints`

## 工作流

1. 接续工作前必读 [memory/process.md](memory/process.md) 末尾段（Plan/Round 决策 + 留作 debt）
2. 实现新 plan/round：先在 [docs/plans/](docs/plans/) 落"观察点 + 验证方式"
3. 完成一段实现：`memory/process.md` 追加 → `npm test` 全绿 → commit
4. Commit 信息按 `memory/process.md` 末尾"提交信息"段格式
5. 每次修改完成并按风险验证后，必须 commit 并立即 push 当前分支，不得把改动停留在未提交或仅本地提交状态；若 push 因权限、网络或远端冲突失败，必须明确报告阻塞

## 命令

| 操作 | 命令 |
|---|---|
| 构建 | `npm run build`（产物 `dist/cli.js`） |
| 测试 | `npm test`（ESM Jest，已配 `--experimental-vm-modules`） |
| 跑 CLI | `node dist/cli.js <cmd>` |
| CLI 命令清单 | `init / status / scan [--all] [--source <dir>] [--agent <name>] / sessions show <id> / projects {list,assign,merge,reclassify}` |

## DB / 状态（FS-first 模型）

- 单文件：`<workspace>/.memory-manager/memory.db` + `-shm` + `-wal`（WAL 模式）
- 默认 workspace：`~/.memory-manager/`；隔离测试用 `HOME=$(pwd)/.scratch`
- Schema 当前 **v5**（`schema_meta.value`）；表清单仅 **3 张**：`sessions / run_metadata / schema_meta`
- 升级路径：v1-v4 → v5 走 `migrateToV5`（drop 旧内容表，不迁数据；本地用户手动 `rm memory.db && init`）

## FS-first 项目视图

```
<workspace>/projects/
├── default/                          ← classifier 兜底（未匹配 session）
└── <slug>/
    └── <session-id>.jsonl  -> /Users/.../agent jsonl   (symlink)
```

- **真理来源**：FS（`ls / cat / grep` 可直接看分类）
- **DB 索引**：`sessions.slug` 与 FS 双向一致，scan / assign / merge / reclassify 都同步两边
- 详见 [docs/specs/scan-classify-fs-rewrite.md](docs/specs/scan-classify-fs-rewrite.md)

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
console.log(db.prepare('SELECT slug, COUNT(*) AS c FROM sessions GROUP BY slug').all())"
```

## 本机真实环境扫描（隔离工作区）

```bash
SCRATCH="$(pwd)/.scratch" && rm -rf "$SCRATCH" && mkdir -p "$SCRATCH"
HOME="$SCRATCH" node dist/cli.js init --non-interactive
mkdir -p "$SCRATCH/.memory-manager/sources"
for a in claude codex copilot cursor gemini grok; do
  ln -sfn ~/.$a "$SCRATCH/.memory-manager/sources/$a"
done
ln -sfn ~/.local/share/opencode "$SCRATCH/.memory-manager/sources/opencode"
ln -sfn ~/.pi/agent "$SCRATCH/.memory-manager/sources/pi"
HOME="$SCRATCH" node dist/cli.js scan --all
HOME="$SCRATCH" node dist/cli.js projects list
```

`.scratch/` 已 .gitignore，不污染默认 home。

## 目录结构

```
src/
  cli.ts                 Commander 入口（命令注册）
  commands/              命令实现层（init / scan / sessions / projects）
  adapters/{claude,codex,copilot,cursor,gemini,grok,opencode,pi}.ts  8 内置 adapter
  adapters/shared.ts     fileHash / readJsonlObjects / defaultNormalize
  scanner.ts             discover → parse → normalize → 写库 + 归类
  classifier.ts          hints → slug 纯函数（classify + normalizeSlug）
  fs-writer.ts           symlink CRUD（linkSession / moveLink / removeLink / listLinks）
  projects.ts            数据层（listProjects / assignSession / mergeProjects / reclassifyAll；全部 FS mv + DB 同步）
  db.ts                  schema + 迁移
  workspace.ts           工作区路径解析
test/
  unit/                  Jest 测试（139+ tests），新测试走 mkdtempSync 临时 fixture
  sources/{claude,codex,copilot,cursor}/  真实 fixture，禁改（4 fixture 分类对账 spec § 验收链路）
docs/plans/{01-08}-*.md  8 个阶段计划
docs/specs/              spec
memory/process.md        实现决策上下文，每段完成后追加
```

## 改动前必查的项目特有约束

- `normalize` **不重算** id / contentHash，复用 discover；仅权威化 updatedAt
- `sessions.updated_at` 必须写 `discover.updatedAt`（不是 `normalize.updatedAt`）—— 否则 unchanged 判定永远失效，process.md R3a 踩坑过
- 新加测试用 `mkdtempSync` 临时 fixture，**禁止改** `test/sources/<agent>/`（影响 4 个 fixture 的 slug 形态对账：boarding-desktop / cloud-code-master / agent-memory-system / moego-chrome-extension）
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
| APP UI 开发 | [DESIGN.md](DESIGN.md)（主题 token、组件映射、布局规范） |
