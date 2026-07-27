# Agent Session 获取逻辑重构

## 范围

参考 `paseo` 的 provider session listing 设计，重构 Claude、Codex、Copilot、Cursor、OpenCode、Pi 的本地 session 获取逻辑。保留现有 `scan`、adapter、FS-first symlink 和 DB 隐私契约，不引入对话原文入库。

## 设计对齐

| Agent | paseo 的权威来源 | memory-manager 落地方式 |
| --- | --- | --- |
| Claude | `CLAUDE_CONFIG_DIR` / `~/.claude/projects/*/*.jsonl` | 自动解析 home，扫描项目目录下全部顶层 JSONL，不要求 UUID 文件名 |
| Codex | `CODEX_HOME` + app-server `thread/list` | 自动解析 home；为保留 `source_path`，递归扫描 `sessions/` 与 `archived_sessions/` 的 rollout JSONL |
| Copilot | `copilot --acp` 的 `session/list` | 自动解析 home；每个 `session-state/<id>` 都是 session，优先使用 `events.jsonl`，否则使用 `workspace.yaml` |
| Cursor | `cursor-agent acp` 的 `session/list` | 自动解析 home；保留可追溯文件引用，扫描每个 `agent-transcripts/<id>/` 的顶层 JSONL |
| OpenCode | SDK `experimental.session.list({ archived: true, roots: true })` | 自动解析 XDG data home，读取 `opencode.db` 的 root session 元数据；不读取/导出消息原文 |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` descriptor | 自动解析 Pi agent/session 环境变量，递归扫描 JSONL，以首行 `type=session` 的 id/cwd 为权威 |

自定义 `--source` 优先级最高；其次使用 `<workspace>/sources/<agent>`；两者均不存在时使用 agent 默认 home。这样现有 fixture、自定义软链和真实环境自动发现可以同时工作。

## 执行步骤

| 步骤 | 独立改动 | 观察点 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 建立跨版本发现测试 | 新布局测试在旧实现上失败 | 运行新增 adapter 测试，确认失败原因分别是默认 home、归档、metadata-only session、宽松命名 | 完成 |
| 2 | 实现默认 source 解析 | 不创建 source 软链也能发现 `~/.<agent>` | 隔离 HOME 调用 `runScan`，断言 session 入库且 symlink 存在 | 完成 |
| 3 | 重构四个 adapter discover/metadata | 四种布局全部返回稳定 session id、hash、时间和项目 hint | 运行 adapter + scan 目标测试 | 完成 |
| 4 | 全链路验证 | 真实四 agent 的 active/archived/metadata-only session 都计入 summary | `npm test`、`npm run build`，隔离工作区真实 `scan --all` 后按 agent 查询 DB 数量 | 完成 |

## 验收标准

1. `memory-manager scan --all` 无需手工创建 source 软链即可扫描本机六个 agent。
2. Codex active 与 archived session 均被扫描，目录层级变化不造成整批漏扫。
3. Copilot 没有 `events.jsonl` 但有 `workspace.yaml` 的 session 仍被扫描并可分类。
4. 重复扫描幂等，单文件或单 agent 错误继续写入 `run_metadata.details`，不静默吞掉。
5. DB 仍只保存 hash、路径及项目元数据，不保存对话原文、tool output 或 prompt。

## OpenCode / Pi 补充轮次

| 步骤 | 独立改动 | 观察点 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 增加两 agent 的 registry 与 fixture 测试 | 旧实现不认识 `opencode` / `pi` | 目标 Jest 在实现前失败 | 完成 |
| 2 | 实现 OpenCode SQLite adapter | archived root sessions 全部可发现，child session 不重复列入 | 临时 SQLite fixture 验证 discover/parse/hints/hash | 完成 |
| 3 | 实现 Pi JSONL adapter | 任意嵌套 JSONL 可发现，无合法 header 的噪声被忽略 | 临时 JSONL fixture 验证 discover/parse/hints | 完成 |
| 4 | 六 agent 全链路验收 | `scan --all` DB 中出现六种 agent | 全量测试、构建、真实隔离扫描与 symlink 对账 | 完成 |

OpenCode 当前没有逐 session JSONL，且 export 会复制对话内容，违反项目隐私红线。因此其 `source_path` 和项目 symlink target 指向权威 `opencode.db`；session hash 只计算 session 表该行的 id/directory/time 元数据，避免任意一条消息变化导致所有 session 同时 updated。

补充轮次验收：139 项测试通过；真实六 agent 扫描 1482 total，Claude 9 / Codex 676 / Copilot 293 / Cursor 312 / OpenCode 118 / Pi 74，errors 0，broken symlink 0。

## 验收结果

- 单元测试：135 项通过。
- 构建：`npm run build` 通过。
- 真实隔离扫描：1290 sessions，Claude 9 / Codex 676 / Copilot 293 / Cursor 312，errors 0。
- FS 视图：1290 个 session symlink，broken 0。
- 重复扫描：实时数据中 1289 unchanged / 1 updated；updated 对应扫描期间仍变化的活跃 session。

## Codex 原文与扫描进度补充轮次

| 步骤 | 独立改动 | 观察点 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 增加 Codex `sessions show` 回归测试 | Codex JSONL 只能被 scan 解析元数据，命令层仍拒绝读取 | 目标 Jest 在实现前失败 | 完成 |
| 2 | 增加 scan progress 回调测试 | 扫描同步 I/O 阻塞 spinner 动画时仍能看到 agent 和处理数量 | 断言 discovering / processing / done 事件及数量 | 完成 |
| 3 | 实现只读原文输出与 spinner 进度文案 | Codex 原文只进 stdout；scan 每个 agent 都有阶段反馈 | 目标 Jest + 真实 Codex/scan smoke test | 完成 |
| 4 | 全链路验收并同步上下文 | DB 不新增原文字段，源 JSONL hash 不变 | 全量测试、构建、`git diff --check` | 完成 |

补充验收：`sessions show <codex-id>` 输出源 JSONL 的结构化 records，不写 DB、不复制 transcript；`scan` 在 agent discover 前、处理期间和完成后更新可见状态，底层 `runScan` 在未提供回调时保持无额外输出。

## Scan 变更清单补充轮次

| 步骤 | 独立改动 | 观察点 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 定义本轮变更条目 | new / updated / missing 均包含 agent、session id、slug | 类型与 formatter 测试先失败 | 完成 |
| 2 | scanner 收集并持久化 changes | summary 与 `run_metadata.details` 使用同一份变更清单 | 集成测试读取返回值和 DB details | 完成 |
| 3 | CLI 输出变更计数 | scan 结束后显示新增、更新、删除、错误数量，不展开 session | formatter 测试 + 伪 TTY smoke test | 完成 |
| 4 | 全链路验收与上下文同步 | 重复扫描不把 unchanged 塞进 changes | 全量测试、构建、`git diff --check` | 完成 |

删除语义固定为“本轮成功扫描该 agent 后，源端不再存在”：session 行保留并标记 `missing`，FS 项目链接删除。变更清单不记录对话内容或 tool output，只记录 `{agent, id, slug}`。

CLI 只展示 `新增 X · 更新 X · 删除 X · 错误 X`；具体 changes 保留在 `run_metadata.details`，避免首次扫描输出数百行。

补充状态转移：已标记 `missing` 的 session 即使以相同 hash/updatedAt 恢复，也计为 `updated`，避免误报 unchanged。

## 六 Agent Session Show 补充轮次

| Agent | show 权威来源 | 不可读取条件 |
| --- | --- | --- |
| Claude | `source_path` 文件或目录下全部 JSONL | 源不存在、JSONL 非法或总量超过上限 |
| Codex | rollout JSONL | 同上 |
| Cursor | transcript JSONL | 同上 |
| Pi | session JSONL | 同上 |
| Copilot | 优先 `events.jsonl`；metadata-only 回退同一 Copilot 根的 `session-store.db.turns` | events 不存在且 turns 为 0 |
| OpenCode | SDK `session.messages` | SDK/本机服务读取失败 |

| 步骤 | 独立改动 | 观察点 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 新增四类未支持 agent 与 Copilot 双路径测试 | 旧命令明确拒绝 Claude/Cursor/Pi/Copilot | 目标 Jest 先失败 | 完成 |
| 2 | 实现严格 JSONL show | 单文件与 Claude 多文件目录均完整返回 records | stdout + 源文件 hash 不变断言 | 完成 |
| 3 | 实现 Copilot turns fallback | 只读固定 `session-state` 父目录的 DB，按 turn_index 输出 | 临时 SQLite fixture + 无 turns 错误测试 | 完成 |
| 4 | 全链路验收与上下文同步 | 六 agent 均有明确结果或源端缺失错误 | 全量测试、构建、真实 smoke、`git diff --check` | 完成 |

所有 show 内容只存在于进程内存与 stdout，不写 memory-manager DB、不生成 transcript、不修改 agent 源数据。

JSONL show 兼容 UTF-8 BOM 与 CRLF；任一非空行解析失败则带文件和行号报错，不静默返回部分内容。单次聚合上限为 50 MiB。

## Project Sessions Metadata 补充轮次

命令：`projects sessions [slug]`。未传 slug 时读取 `projects/` 下全部 session，传入时只读取该项目。FS link 决定结果范围，DB 提供 sessions 表 metadata；不读取任何 source transcript。

| 步骤 | 独立改动 | 观察点 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 新增 metadata 查询测试 | 全量与单 slug 返回稳定字段和排序 | 目标 Jest 先失败 | 完成 |
| 2 | 实现 FS 范围 + DB metadata join | FS/DB 缺行或 slug 不一致明确报错 | 数据层测试 | 完成 |
| 3 | 注册 CLI 命令并输出 JSON | `projects sessions` 与 `projects sessions <slug>` 均可执行 | CLI smoke test | 完成 |
| 4 | 全链路验收与上下文同步 | 输出不包含对话原文 | 全量测试、构建、`git diff --check` | 完成 |

输出字段覆盖 sessions 表全部 metadata：id、agent、sourcePath、workspaceLink、slug、contentHash、updatedAt、status、firstSeenAt、lastSeenAt、classifiedAt、rulesStatus、rulesGeneratedAt。
