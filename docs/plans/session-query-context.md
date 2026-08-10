# Session Query 与完整上下文 CLI — Plan

> spec：`docs/specs/session-query-context.md`

## 目标与范围

实现可组合的 Session Query Engine、六 Agent 统一事件 Reader、带选择证明的私有 Context 分片 CLI，以及仓库级
`local-session-context` Skill。首版完整交付工具使用复盘和最近 7 天全量总结两个场景，不新增持久化全文索引，数据库
schema 不变。

## 最小端到端骨架

```bash
npm test -w @memory-manager/core -- --runInBand \
  packages/core/test/unit/session-query.test.ts \
  packages/core/test/unit/session-context-cli.test.ts
```

最小链路必须证明：一个 Codex fixture 经 `prepare` 由结构化工具调用命中，生成一个私有 context run，再由 `read`
返回完整有序事件，最后 `close` 删除 run。

## Chunk 1：查询合同与统一事件 Reader

| 步骤 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|
| 1.1 定义 Query JSON v1、布尔谓词、选择账本和 MatchProof 类型 | 未知版本/字段/空谓词拒绝；账本恒等式成立 | `session-query.test.ts` schema 与纯函数测试 | 已完成 |
| 1.2 实现 JSONL 事件标准化，覆盖 Claude/Codex/Cursor/Pi/Copilot | message/tool call/tool result 保序，Skill catalog 不算调用 | 六 Agent fixture 定向测试 | 已完成 |
| 1.3 实现 OpenCode SQLite 事件标准化 | message/part 顺序、工具 part、call id 可回查 | 临时 SQLite fixture 测试 | 已完成 |
| 1.4 固定 JSONL/SQLite 水位并保留失败终态 | changed/missing/invalid/empty 不静默丢失 | 变化和失败注入测试 | 已完成 |

## Chunk 2：工具、关键词与组合查询

| 步骤 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|
| 2.1 实现版本化 Tool Family Registry | direct/nested/capability-derived 分开证明 | computer/chrome 正反 fixture | 已完成 |
| 2.2 实现字段化关键词匹配 | 默认排除 system、Skill/tool catalog；locator/hash 稳定 | 字段、大小写、any/all 测试 | 已完成 |
| 2.3 实现递归 all/any/not 与 metadata candidate scope | 时间/agent/project/status 可组合，排序稳定 | query matrix 与非法深度测试 | 已完成 |
| 2.4 生成 Selection Coverage 与逐 Session 证明 | candidates=inspected+unknown；unknown 禁止完整声明 | 失败候选集成测试 | 已完成 |

## Chunk 3：Context prepare/read/status/close

| 步骤 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|
| 3.1 实现私有 run、manifest 和事件分片 | 0700/0600；事件不重复不遗漏；按 event boundary 切分 | 权限/分片/大事件测试 | 已完成 |
| 3.2 注册四个 CLI 子命令与 JSON stdout 合同 | query-json/file 互斥；错误非零；输出可脚本消费 | Commander/命令集成测试 | 已完成 |
| 3.3 实现 TTL、status、close 与路径防护 | 只删目标 run；重复 close 明确；无关目录保留 | stale/path traversal 测试 | 已完成 |
| 3.4 对失败与动态来源保持可读账本 | 部分失败仍可读命中 Session，限制可见 | prepare/read 集成测试 | 已完成 |

## Chunk 4：Skill

| 步骤 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|
| 4.1 用 `skill-creator` 初始化 `.agents/skills/local-session-context` | 目录、frontmatter、`agents/openai.yaml` 合规 | `quick_validate.py` | 已完成 |
| 4.2 编写核心工作流和两个配方 | AI 会先检查 coverage，再穷举 session × part，最后 close | 静态合同测试 + 手工 dry run | 已完成 |
| 4.3 增加 Query/CLI 参考文档 | SKILL.md 精简，详细 schema 单层引用 | reference 路径与命令对账 | 已完成 |

## Chunk 5：全量与真实验收

| 步骤 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|
| 5.1 Core 全量回归与构建 | 既有 Session/Rules/Live Evidence 无回归 | `npm test`、`npm run build` | 已完成 |
| 5.2 隔离 HOME 真实扫描最近 30 天工具场景 | computer/chrome 命中有证明；unknown 被披露 | `scan --all` + `context prepare/status/read/close` | 已完成 |
| 5.3 隔离 HOME 真实最近 7 天全量场景 | 所有候选都有终态；所有命中 parts 可枚举 | 全量 query + manifest 对账 | 已完成 |
| 5.4 完成隐私、文档和 Git 审计 | DB 无正文新列/表；临时 run 已清；工作树干净 | `git diff --check`、DB schema、status、push SHA | 已完成 |

## 风险与门禁

- **工具误报**：只从标准化 tool call 识别；嵌套调用需通过受限解析器抽取实际调用表达式。
- **关键词污染**：系统注入和工具能力清单默认不进入可检索字段。
- **虚假全量**：selection 与 context 各自记账；任何 unknown 都必须进入输出限制。
- **跨进程临时状态**：run 目录使用随机 ID、固定前缀和 manifest 校验，不依赖创建进程 PID 存活。
- **动态源**：读取水位随 run 固定，变化只披露，不混入下一版本内容。
- **大 Session**：按事件边界分片；单事件超过阈值时单独成片，不截断。
- **大候选集**：逐 Session 回源、判定并把命中项立即写入 run；Query 只保留 outcome 元数据，不累计候选正文。
- **历史 Prompt injection**：Skill 把事件当数据，不执行历史命令。

## 最终验收命令

```bash
npm test
npm run build
python /Users/moego-winches/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .agents/skills/local-session-context
git diff --check
```

完成后更新本 Plan 状态和 `memory/process.md`，按仓库规则提交并立即推送当前分支。

## 完成记录（2026-08-10）

- 隔离 workspace 扫描 6 个 Agent 共 2,149 个 Session，0 error；未修改默认 `~/.memory-manager`。
- 首次真实 30 天查询因把 978 个候选正文同时留在内存而在约 4 GiB OOM。修复为逐 Session 流式判定与即时分片后，
  同一查询稳定完成：976 inspected、1 matched、2 unknown；命中证明为 nested computer-use，6 parts / 728 events 全量对账。
- 真实字段化关键词查询在相同候选集中命中 260 个 Session，proof 来自 user、assistant、tool input、tool result，
  system/Skill catalog 不参与。
- 真实最近 7 天全量查询为 326 candidates / inspected / matched、0 unknown，生成 2,477 parts / 105,592 events；
  每个 Session 的 part 数、event index 连续性、唯一性与 eventCount 全部对账，随后 close。
- `memory.db` 仍只有 `llm_runs / rule_candidates / run_metadata / schema_meta / sessions` 五张表；Context 临时目录清空。
- Core 41 suites / 387 tests、production build、TypeScript noEmit、Skill validator 和 `git diff --check` 通过。
