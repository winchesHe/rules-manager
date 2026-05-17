# scan-classify-fs-rewrite — Plan

> 实现节奏。完成后由 `flow-ship` 归档到 `docs/plans/done/`。
> spec：`docs/specs/scan-classify-fs-rewrite.md`

## 步骤节奏

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 1 | schema v5 + `migrateV4ToV5` + `init` 建 `projects/default/` + scanner 跑 claude 单 agent → FS symlink + DB sessions 单表写入 | `ls <ws>/projects/default/` 存在；`ls <ws>/projects/<slug>/*.jsonl` 有 symlink；memory.db 只 3 张表 | 单元测试新 `fs-writer.test.ts` 通过；`.scratch` 跑 init + scan --agent claude 后 `find projects -name '*.jsonl'` 数量 = sessions 表行数；`sqlite_master` 仅 schema_meta / sessions / run_metadata | ✅ | 2026-05-17 |
| 2 | 扩 4 agent + default 兜底 | `ls projects/` 多个 slug 子目录；未匹配 session 落 `default/` | `scan --all` 后 `find projects -name '*.jsonl' \| wc -l` = scan summary total；DB 中 `slug='default'` 行数与 `ls projects/default/` 一致 | ✅ | 2026-05-17 |
| 3 | classifier 重写为纯函数 `classify(hints): string` + `normalizeSlug` | classifier 单测；slug 形态 lowercase 连字符 | `npm test classifier`；test/sources 4 fixture slug 形态符合 spec 表格（`boarding-desktop` / `cloud-code-master` / `agent-memory-system` / `moego-chrome-extension`） | ✅ | 2026-05-17 |
| 4 | `status` / `projects list` 重写（从 FS 读 + DB 反查 agent） | CLI 输出格式 | `projects list` 输出 slug + sessions 计数 + agent 集合，且与 `ls projects/` 数量一致；`status` 给出 status / slug / agent 三维摘要 | ✅（list；status 未扩） | 2026-05-17 |
| 5 | `projects assign` / `merge`（FS mv + DB sync） | assign 后文件位置变 + sessions.slug 变；merge 后 from/ 目录消失 | E2E 测试：assign 后 ls + sqlite 双向一致；merge 后 from 目录被清理（default 除外）；merge 到不存在 to 自动创建 | ✅ | 2026-05-17 |
| 6 | `projects reclassify`（重读 jsonl + classify + mv） | 偏移的 sid 被还原到正确 slug | E2E：先 assign 偏移到 manual-x，再 reclassify → 该 sid 回到 classifier 推断的 slug；hints 表已砍，全程不写 | ✅ | 2026-05-17 |
| 7 | 砍死代码 | src/types.ts 缩；grep 无残留 | `grep -rn "session_projects\|project_hints\|rule_candidates\|ProjectClassification\|UNKNOWN_PROJECT_KEY" src/` 无命中；`npm test` 全绿；`npm run build` 无 unused export warning | ✅ | 2026-05-17 |
| 8 | 同步文档：`memory/process.md` 加段、`docs/plans/02 / 04` 顶部加 superseded 注、`AGENTS.md` 更新 DB / FS 段 | 文档体现新模型 | 人工 review；`grep -n "session_projects" memory/process.md AGENTS.md` 应只在"已废弃"上下文出现 | ✅ | 2026-05-17 |
| 9 | 真实环境验证 | 669 session 真实数据上跑通；default 比例 < 20% | `.scratch` 工作区 scan --all + `ls projects/` + 抽样 1-2 session 跑 assign/merge/reclassify；DB 仅 3 张表；symlink cat 可读 | ✅（default=0%） | 2026-05-17 |

## 未确认假设

- ⚠ `<workspace>/projects/default/` 在 `init` 时建好（不只 scan 命中时建） —— **步 1 验证**
- ⚠ symlink 在 macOS 是常规操作，无权限障碍 —— **步 1 验证**
- ⚠ classifier 单 session 决定 slug 足够（无需多 session 投票） —— **步 9 在 669 真实数据验证 default 比例 < 20%**

## 风险点 + 兜底

- **测试大改 ~30+ 条**：先在步 1 列废测试清单（含路径 + 行数 + 废原因），新测试按 `mkdtempSync` 临时工作区惯例写；不强求一一迁移
- **reclassify 性能**：669 session 估算 < 5s 可接受；如步 9 实测 > 30s，兜底加内存级 hints cache（仍不入库）
- **merge 原子性**：mv 目录 + UPDATE 非事务；兜底"DB 先于 FS"+ 下次 scan 用 FS 视图 reconcile（FS 为真）
- **Plan 05 brainstorm 设计部分作废**：rule_candidates 方案换形态；本 plan 完成后重启 Plan 05 R1 brainstorm

## 决策记录（活更新，Y-only）

### 步 1-4 合并完成（2026-05-17）

- **影响**：步 1 端到端骨架天然带动步 2（4 agent 主循环通用）/ 步 3（classifier 重写）/ 步 4（list 重写），实际一波做完。后续 5-9 步顺序不变。**步 4 中 `status` 命令的"slug / status / agent 三维摘要"未做**（当前 `status` 仍是 init/db ready 4 行；要不要扩，等步 5-6 后再看）
- **新发现的事实**：
  - codex 真实数据里出现 1 个 cwd 为 lody chat 目录（`/Users/.../lody/chats/<UUID>`），basename 是纯 UUID → 产生 UUID 形态 slug。真实数据原生现象，可后续 `projects assign` 修；不算 bug
  - claude multi-file session 的 sourcePath 是目录（不是单 jsonl 文件），symlink target 因此是目录。`cat` 直接读不可用，但 `lstat / readlink / find / 进目录` 都正常；`listLinks` 已用 `isFile() || isSymbolicLink()` 兼容
  - 真实环境 `default` slug 比例 **0%**（638 sessions 中 0 个），远好于 spec § 假设第 4 条的「< 20%」预期
- **假设回填**：
  - ⚠ `projects/default/` 在 init 建好 → 已确认（init 测试 + .scratch 实测）
  - ⚠ symlink macOS 无权限障碍 → 已确认
  - ⚠ classifier 单 session 决定 slug 足够 → 已确认（default=0%）
