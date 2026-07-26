# scan-classify-fs-rewrite

## 概述

memory-manager 当前 schema v4 把项目分类 / 归属 / hints / rules 候选全塞进 DB（4 张内容表），导致：

1. 物理目录里看不到分类（要查 DB 才知道某 session 属于哪个项目）
2. assign / merge / reclassify 全是 DB 行 mv，难调试
3. classifier + projects 数据层多层抽象，"什么都塞 DB"风格难管理

本次重构把真理来源切到 **「FS-first，DB 只记状态」**：

- `<workspace>/projects/<slug>/*.jsonl` 是物理可见的分类视图，里面是原 jsonl 的 **symlink**
- 未匹配落 `<workspace>/projects/default/`
- DB 退化为单表 `sessions`（+ `schema_meta` + `run_metadata` 共 3 张），回答"哪些要处理 / 在哪个 slug / 分过类没 / 生成过 rule 没"

工作区根：`~/.memory-manager/`（不变）

核心目标：

1. `ls <workspace>/projects/` 即看到所有项目分类
2. `cat <workspace>/projects/<slug>/<file>.jsonl` 直接读原始 session 内容
3. DB 只保留 `schema_meta` / `sessions` / `run_metadata` 三张表
4. `assign` / `merge` / `reclassify` 全部对 FS 操作 + DB 状态同步

## 非目标

MVP 不做：

1. 不改 adapter 接口（5 方法 `probe / discover / parse / normalize / extractProjectHints` 保留）
2. 不修 codex 日级目录之外的 adapter 行为
3. 不做工作区迁移工具（v4 → v5 直接 drop 4 张表 + alter sessions）
4. 不做 FS view 的 watch / 反向同步（FS 只读视图，所有写都从命令触发）
5. 不支持 Windows（symlink 需管理员权限）
6. 不实现 rule_candidates 表（rules 落 `<slug>/rules.md`，DB 只 1 列 `rules_status`）

## 工作区结构

```text
~/.memory-manager/
├── memory.db                          ← SQLite 单文件（3 表，WAL 模式）
├── memory.db-shm
├── memory.db-wal
├── sources/                           ← agent 数据源软链（已有）
│   ├── claude  -> ~/.claude
│   ├── codex   -> ~/.codex
│   ├── copilot -> ~/.copilot
│   └── cursor  -> ~/.cursor
├── projects/                          ← 【新】FS-first 分类视图
│   ├── default/                       ← classifier 未匹配的 session
│   │   ├── <session-id-1>.jsonl  -> /Users/.../agent jsonl
│   │   └── ...
│   ├── <slug-1>/                      ← 例：agent-slack / cloud-code-master / boarding-desktop
│   │   ├── <session-id>.jsonl    -> /Users/.../...
│   │   └── ...
│   └── <slug-N>/
│       ├── <session-id>.jsonl    -> /Users/.../...
│       └── rules.md              ← 【Plan 05 用】预留位置
└── rules/                             ← init 时已有的空目录（待 Plan 07 用）
```

| 路径 | 作用 |
|---|---|
| `projects/<slug>/<session-id>.jsonl` | symlink，指向 agent 原 jsonl，可直接 `cat / grep` |
| `projects/<slug>/rules.md` | Plan 05 LLM 输出（本 spec 不实现，目录预留） |
| `projects/default/` | classifier 未确定归属的兜底；init 时建好 |

**slug 命名规则**：仅允许 `[a-z0-9-]`，由 classifier 从 hint 启发式归一化产出；`default` 保留给未匹配 session。

**filename 规则**：直接用 `<session-id>.jsonl`（session-id 是 UUID，全局唯一，跨 agent 不冲突）；不分 agent 子目录，agent 信息在 `sessions.agent` 列。

## 数据模型 / Schema v5

```sql
-- 全部表（共 3 张）

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                       -- version = '5'
);

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,    -- session UUID
  agent                TEXT NOT NULL,        -- claude / codex / copilot / cursor
  source_path          TEXT NOT NULL,        -- agent 原 jsonl 绝对路径（symlink target）
  workspace_link       TEXT NOT NULL,        -- <workspace>/projects/<slug>/<id>.jsonl 绝对路径
  slug                 TEXT NOT NULL,        -- 项目 slug，'default' 表未匹配
  content_hash         TEXT NOT NULL,        -- sha256 文件指纹
  updated_at           TEXT NOT NULL,        -- discover.updatedAt（new/updated 判定基准）
  status               TEXT NOT NULL,        -- new / updated / unchanged / missing / error
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  classified_at        TEXT,                 -- 何时分类（null = 未分类）
  rules_status         TEXT,                 -- null / pending / done / failed（Plan 05+）
  rules_generated_at   TEXT                  -- 何时生成 rule（Plan 05+）
);

CREATE TABLE run_metadata (
  id         TEXT PRIMARY KEY,
  run_type   TEXT NOT NULL,                  -- scan / reclassify / generate-rules
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  status     TEXT NOT NULL,                  -- running / success / partial / failed
  details    TEXT                            -- JSON 摘要 + 错误列表
);
```

**v4 → v5 砍掉**：

| 砍掉的表 | 数据去哪 |
|---|---|
| `projects` | `<workspace>/projects/<slug>/` 目录列表 |
| `session_projects` | `sessions.slug` 直接存 |
| `project_hints` | reclassify 时重读 jsonl 抽（session 已在 fs 可读） |
| `rule_candidates` | rule 文本去 `projects/<slug>/rules.md`，状态记 `sessions.rules_status` |

**v4 → v5 sessions 表变化**：

| 列 | 变化 |
|---|---|
| `project_key` | 改名 `slug`，默认 'default' |
| `workspace_link` | 新增 |
| `scan_state` | 改名 `status`（语义不变） |
| `message_count` / `tool_call_count` / `first_timestamp` / `last_timestamp` / `parsed_metadata` | **砍掉**（需要 metadata 时回 jsonl 临时读，不入库） |
| `source_kind` | 砍掉（默认 jsonl，未来需要再加） |
| `classified_at` / `rules_status` / `rules_generated_at` | 新增 |

## 接口设计

CLI 命令：

```bash
# 行为不变
memory-manager init --non-interactive
memory-manager status
memory-manager scan [--all] [--agent <name>] [--source <dir>]

# 行为重写
memory-manager projects list                                # ls projects/ 目录 + DB 反查 agent 集合
memory-manager projects assign <session-id> <slug>          # mv symlink + UPDATE sessions.slug
memory-manager projects merge <from> <to>                   # mv 目录内全部 symlink + 批量 UPDATE sessions.slug
memory-manager projects reclassify [--pending]              # 重读 jsonl + classify + 必要时 mv
```

slug 归一化（在 classifier 内）：

```ts
function normalizeSlug(raw: string | null): string {
  if (!raw) return 'default';
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'default';
}
```

举例（对比 v4 输出）：

| hint 来源 | v4 projectKey | v5 slug |
|---|---|---|
| claude cwd `/Users/u/Moe/Boarding_Desktop` | `Boarding_Desktop` | `boarding-desktop` |
| codex cwd `/Users/u/cloud-code-master` | `cloud-code-master` | `cloud-code-master` |
| copilot git_root `agent-memory-system` | `agent-memory-system` | `agent-memory-system` |
| cursor lossy `Moe-moego-chrome-extension` | `moego-chrome-extension` | `moego-chrome-extension` |

## 子系统设计

### classifier（重写为纯函数）

旧 `src/classifier.ts` 输出 `{ projectKey, confidence, decisionHint }`。新版直接返回 `slug`：

```ts
function classify(hints: ProjectHint[]): string {
  // 1. 按优先级 git_root > cwd > source_project_path > message_path > git_remote 选 hint
  // 2. 从 hint.value 抽 basename / 启发式得 raw（cursor 取后 N=3 段保留）
  // 3. normalizeSlug(raw) 输出
  // 4. 无 standalone-decidable hint → 'default'
}
```

confidence 概念**砍掉**（FS 上看分类质量靠目录内文件数；`assign` / `merge` 即人工修正信号）。

### fs-writer（新增）

```ts
// src/fs-writer.ts
function linkSession(workspaceDir: string, slug: string, sessionId: string, sourcePath: string): string {
  // mkdir -p <workspaceDir>/projects/<slug>/
  // ln -sfn <sourcePath> <workspaceDir>/projects/<slug>/<sessionId>.jsonl
  // 返回 link 绝对路径
}

function moveLink(workspaceDir: string, sessionId: string, fromSlug: string, toSlug: string): string {
  // mv <workspaceDir>/projects/<fromSlug>/<sessionId>.jsonl → <toSlug>/...
  // 旧目录变空且非 default → rmdir
}

function removeLink(workspaceDir: string, slug: string, sessionId: string): void {
  // unlink；旧目录变空且非 default → rmdir
}

function listLinks(workspaceDir: string): Map<string, string[]> {
  // 遍历 projects/ → { slug → sessionId[] }
}
```

### scanner（重写主循环）

```text
for adapter of adapters:
  for session of adapter.discover(...):
    parse → normalize
    hints = adapter.extractProjectHints(session)
    slug = classify(hints)
    workspaceLink = linkSession(workspace, slug, session.id, session.sourcePath)
    INSERT/UPDATE sessions (含 slug + workspace_link)
```

missing 处理：

- 反向遍历 DB sessions，本轮 agent 没扫到的 → status='missing'
- 同时 `removeLink(slug, sessionId)` 让 FS 视图反映 missing

### projects 命令层（重写）

```text
list:       listLinks(workspaceDir) → 按 slug 分组 → DB 反查每个 sid 的 agent → 输出
assign:     验证 sid 存在 → moveLink → UPDATE sessions.slug + classified_at
merge:      listLinks 取 from 全 sid → moveLink each → 批量 UPDATE
reclassify: for sid in sessions: 读 source_path jsonl → extractProjectHints → classify → 比较旧 slug → moveLink + UPDATE
```

## 改动范围

### 文件改动

| 文件 | 操作 |
|---|---|
| `src/db.ts` | 改：schema v5 + `migrateV4ToV5`（drop 4 表 + alter sessions） |
| `src/scanner.ts` | 改：调 fs-writer，砍 hints / session_projects 写入 |
| `src/classifier.ts` | 改：简化为纯函数 `classify(hints): string` |
| `src/projects.ts` | 改：list / assign / merge / reclassify 全部走 FS |
| `src/commands/projects.ts` | 改：CLI 输出格式 |
| `src/commands/init.ts` | 改：建 `<workspace>/projects/default/` 占位 |
| `src/workspace.ts` | 改：加 `projectsDir` 字段 |
| `src/types.ts` | 改：删 `ProjectClassification` / `UNKNOWN_PROJECT_KEY`；保留 `ProjectHint` |
| `src/fs-writer.ts` | **新增**：symlink CRUD |

### 测试改动

| 测试 | 操作 |
|---|---|
| `test/unit/projects.test.ts` | 重写：断言 FS 目录 + sessions.slug |
| `test/unit/projects-mutations.test.ts` | 重写：断言 mv 行为 + DB 同步 |
| `test/unit/scan-r3.test.ts` | 改：去掉 hints / session_projects 断言；新增 symlink 检查 |
| `test/unit/workspace-state.test.ts` | 改：schema_meta.version='5'；3 表白名单 |
| `test/unit/classifier.test.ts` | 改：断言返回 slug 字符串 |
| `test/unit/adapter-parse-normalize.test.ts` | 不动 |
| `test/unit/codex-discover.test.ts` | 不动 |
| `test/unit/adapters-registry.test.ts` | 不动 |
| `test/unit/fs-writer.test.ts` | **新增**：symlink CRUD 测试（mkdtempSync） |

### 数据迁移

- `migrateV4ToV5`：drop projects / session_projects / project_hints / rule_candidates；alter sessions
- 本地用户：`rm -rf ~/.memory-manager/memory.db && memory-manager init`（用户手动）
- 隔离工作区 `.scratch/`：直接 `rm -rf .scratch/` 重扫

## 安全策略

1. **不入库内容**：sessions 表延续 spec 1 节红线，只存路径引用 + 指纹 + 状态；jsonl 内容只在 reclassify / Plan 05 generate-rules 时临时读
2. **symlink 不指向不存在文件**：linkSession 前 `fs.existsSync(sourcePath)` 校验，缺失则跳过 + 记 errors
3. **rmdir 谨慎**：删空目录前确认目录路径在 `<workspace>/projects/` 之内（防越界 mv），且不删 `default/`
4. **slug 字符白名单**：归一化后仍含异常字符（如 `..`、`/`）→ fallback `default`

## 假设

- ⚠ `<workspace>/projects/default/` 在 `init` 时建好（不只在 scan 命中时按需建）—— 步 1 验证
- ⚠ 用户主 `~/.memory-manager/` 由用户手动清理（spec 不提供迁移命令）—— 实施前明问用户确认接受
- ⚠ symlink 在 macOS 是常规操作，无权限障碍 —— 步 1 实测
- ⚠ classifier 单 session 决定 slug 足够（不需多 session 投票）—— 步 9 真实数据验证 `default` 比例 < 20%
- ⚠ 同 sessionId 跨 agent 不冲突（UUID 全局唯一）—— 现有 669 真实数据已验证

## 风险

- **测试大改 ~30+ 条**：当前测试直接断言被砍的表。兜底：先列废测试清单，新测试按 `mkdtempSync` 临时工作区惯例写
- **reclassify 性能**：旧版从 hints 表读；新版重读 jsonl。本机 669 session 估算 < 5s；超慢加内存缓存（不入库）
- **merge 原子性**：mv 目录 + UPDATE sessions.slug 非事务。兜底：DB 先于 FS，崩溃时 scan 用 FS 视图 reconcile（FS 为真）
- **Plan 05 brainstorm 设计部分作废**：rule_candidates 方案换形态，本次完成后重走 Plan 05 R1 brainstorm 末段
- **symlink 跨用户拷贝失效**：spec 已声明 macOS / Linux 本地优先

## 验收链路

```bash
# 1. 隔离工作区初始化（无主 home 污染）
SCRATCH="$(pwd)/.scratch" && rm -rf "$SCRATCH"
HOME="$SCRATCH" node dist/cli.js init --non-interactive
ls "$SCRATCH/.memory-manager/projects/"
# 必须看到：default/

# 2. 软链 4 agent
mkdir -p "$SCRATCH/.memory-manager/sources"
for a in claude codex copilot cursor; do
  ln -sfn ~/.$a "$SCRATCH/.memory-manager/sources/$a"
done

# 3. 扫描
HOME="$SCRATCH" node dist/cli.js scan --all
ls "$SCRATCH/.memory-manager/projects/"
# 必须看到多个 slug 子目录

# 4. 物理验证
ls "$SCRATCH/.memory-manager/projects/agent-slack/" | head -5
cat "$SCRATCH/.memory-manager/projects/agent-slack/<sid>.jsonl" | head -2
# symlink 必须可直接 cat

# 5. DB 验证（3 张表）
node -e "const db=new(require('better-sqlite3'))('$SCRATCH/.memory-manager/memory.db',{readonly:true}); \
  console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all())"
# 输出必须只有：schema_meta / sessions / run_metadata

# 6. projects list
HOME="$SCRATCH" node dist/cli.js projects list
# 必须看到 slug + sessions 计数 + agent 集合，且与 ls projects/ 数量一致

# 7. assign + merge
HOME="$SCRATCH" node dist/cli.js projects assign <sid> manual-project
# 验证：projects/manual-project/<sid>.jsonl 存在 + sessions.slug='manual-project'
HOME="$SCRATCH" node dist/cli.js projects merge manual-project agent-slack
# 验证：projects/manual-project/ 删除（或空）+ sid 在 agent-slack/

# 8. reclassify
HOME="$SCRATCH" node dist/cli.js projects reclassify
# 输出 total/changed/unchanged；FS 上 mv 真实发生
```

必须证明：

1. `<workspace>/projects/default/` 在 `init` 时建好
2. `scan --all` 后 `<workspace>/projects/` 下有多个 slug 子目录 + symlink，target 指向原 jsonl
3. `cat <workspace>/projects/<slug>/<sid>.jsonl` 直接读到原始内容
4. DB 只有 3 张表（`schema_meta` / `sessions` / `run_metadata`）
5. `projects list` 从 FS 读出与 DB sessions.slug 一致
6. `assign` + `merge` 后 FS 和 DB 双向一致
7. `reclassify` 重读 jsonl 抽 hints → classify → 必要时 mv symlink
8. 真实环境 `default` slug 占比 < 20%（669 session 数据上）
9. Plan 04 4 fixture 仍能识别（slug 形态归一化为 `boarding-desktop` / `cloud-code-master` / `agent-memory-system` / `moego-chrome-extension`）

## 后续实现顺序

按"端到端最小骨架"原则：

1. **schema v5 + 最小骨架** —— `migrateV4ToV5` + `init` 建 `projects/default/` + scanner 跑 1 个 agent（claude）→ FS symlink + DB sessions 单表写入
2. **扩 4 agent + default 兜底** —— 全 4 adapter 跑通；未匹配落 `default/`；旧表写入路径全删
3. **classifier 简化为纯函数** —— `classify(hints): string` + normalizeSlug
4. **status / projects list 重写** —— 从 FS 读 + DB 反查
5. **projects assign / merge** —— FS mv + DB sync
6. **projects reclassify** —— 重读 jsonl + classify + mv
7. **砍死代码** —— 删 v4 残留 `projects.ts` / `classifier.ts` 旧抽象、`types.ts` 废类型
8. **同步文档** —— `memory/process.md` + `docs/plans/02 / 04` 标 superseded + `AGENTS.md`
9. **真实环境验证** —— 本机 669 session 跑一遍 default 比例 + assign/merge/reclassify 实操

大需求 → 此节细化到 `docs/plans/scan-classify-fs-rewrite.md`。

## 依赖

- 上游 PR / npm tag / proto 版本：无（本仓内部重构）
- 数据迁移：v4 → v5 `migrateV4ToV5`（drop 4 表 + alter sessions）。本机用户手动 `rm -rf memory.db && init`，不提供自动迁移工具
- 上线顺序：spec OK → 步 1-9 顺序实现 → 完成后重启 Plan 05 R1 brainstorm

## 参考

- 当前实现基线 commits：`bed6dff` Plan 04 R2 / `8bba9bf` codex 修复 / `a639e31` AGENTS.md
- 被 superseded 的文档：`docs/plans/02-scan-sources.md`、`docs/plans/04-project-classification.md`、`memory/process.md` Plan 02 / 04 段
- 详细 plan：`docs/plans/scan-classify-fs-rewrite.md`（4 指标 ≥ 2 必建）
