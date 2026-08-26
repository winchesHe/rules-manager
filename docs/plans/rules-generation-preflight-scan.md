# 最近 7 天规则生成前置扫描

## 范围与验收标准

- `changed7d` 规则生成在 Evidence 提取前复用现有后台 Scan Worker，扫描全部六类 Agent
  最近 7 天的 Session，刷新 `new / updated / unchanged` 索引状态。
- 已有同范围扫描运行时直接等待其结果；已有其他范围扫描时先等待，再执行本次所需的全 Agent
  7 天扫描，避免并发写 DB 与 FS 项目视图。
- Scan Worker 失败、取消或返回非零错误数时停止规则生成，并把明确错误写入生成 Chat；不得用旧索引
  静默继续。
- Evidence Snapshot 继续记录已读取的 `sourceSessions` 以便审计；生成 Chat 的 Session Context 只包含
  实际产生 excerpt 的 Session，空 Session 或只有既有规则基线的 Session 不得生成 `agent: unknown`。
- `recent / full / projects` 保持现有范围语义，本轮不隐式扩大扫描范围。

## Step 1 · Scan Controller 可等待合同

- 新增可等待的扫描入口，复用 `start / status / cancel` 与既有 Worker 事件。
- 观察点：Promise 仅在 Worker `done` 后返回；`failed / cancelled` 明确拒绝；同范围活跃扫描不重复启动。
- 验证方式：扩展 `scan-controller.test.ts`，覆盖完成、失败、取消、同范围复用和异范围串行。

## Step 2 · Rules Generation 前置扫描

- 在 Native Rules Chat 的 `changed7d` 路径中先调用 7 天全 Agent 扫描，再进入 `runRulesGenerate`。
- 观察点：扫描失败时 Provider 没有收到请求；扫描成功后 Evidence 使用本次刷新后的 DB 索引。
- 验证方式：Native Rules 单元测试锁定调用顺序与错误透传；IPC 组合合同检查使用同一
  `ScanController`，不创建第二套扫描实现。

## Step 3 · Session Context 有效引用

- 从 Evidence excerpt locator 构建 Context 引用；`sourceSessions` 中没有 excerpt 的 Session 只保留在
  Snapshot，不进入 Context。
- 观察点：包含空 Copilot Session 的 bundle 不再产生 `unknown`，有效 Codex / Claude / OpenCode 等
  Session 引用继续去重并注入。
- 验证方式：定向单元测试覆盖“空 Session + 有效 Session”混合集合与全空集合。

## Step 4 · 完整回归与真实验收

- 运行 App 定向测试、App/Core 全量测试、production build 与 `git diff --check`。
- 使用本机真实索引执行 `changed7d` 的扫描、Evidence 提取与 Context 组装，确认空 Copilot Session 未阻塞，
  且最终引用不含不受支持的 Agent；该验证停在 Provider 调用前，不消耗真实模型请求。
- 完成后同步 `memory/process.md`，按项目规则 commit 并立即 push 当前分支。

## 验收结果（2026-08-10）

- App 全量 45 suites / 282 tests、Core 全量 36 suites / 359 tests 通过；App 与 Core production build
  通过，App build 仅保留既有 `markstream-react` PURE comment warning。
- 本机真实最近 7 天扫描处理 143 个 Session：16 new、6 updated、121 unchanged、0 errors。
- 同一份真实 Evidence 包含 143 个 `sourceSessions`；8 个没有 excerpt 的 Session 保留在 Snapshot 审计中，
  未进入 Context；最终 135 个 Context 引用全部属于六类受支持 Agent，`unknown` 为 0。
- 真实验证未调用模型；Provider 调用前的扫描、Evidence 提取和 Context 组装门禁均已覆盖。
