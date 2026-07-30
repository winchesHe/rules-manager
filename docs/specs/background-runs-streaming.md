# background-runs-streaming

## 概述

Memory Manager 的 Scan 与 Generate 已经运行在后台 Worker 中，但仍使用两套独立、只覆盖 `running / done / failed` 的控制逻辑。当前结果是：

- 页面切换后虽然后台任务仍在运行，但页面级导航状态会丢失，用户无法重新进入 Generate 过程；
- Scan 与 Generate 都没有真正的取消链路；
- Generate 只暴露阶段进度，Claude/Codex 的真实输出被缓冲到结束；
- Evidence 提取不可观察，用户无法确认本次生成使用了哪些 Project / Session；
- Scan 与 Generate 的恢复、异常中断和并发语义不一致。

本功能把两者统一为“可观察、可恢复、可取消的后台 Run”，并将 Generate 设计为一次用户可见的连续 Agent Run。内部允许为上下文拆分执行多个 Provider 请求，但 UI 不把 Project 表现成独立对话；Project 只作为 Evidence 来源与候选规则归属。

核心目标：

1. Scan / Generate 共用一致的 Run 状态、Run ID、事件序号、取消和恢复语义。
2. 页面切换或 Renderer 重挂载后，可以恢复当前 Run 并补齐流式输出。
3. Scan 和 Generate 都能真正停止底层工作，而不是只修改按钮状态。
4. Claude 与 Codex 输出真实流式事件，最终结构化结果仍是唯一权威结果。
5. Generate 启动时冻结 Evidence snapshot，并可从 Run detail 查看来源。

## 非目标

本次不做以下能力：

1. App 完全退出后自动恢复或续跑 Scan / Generate。
2. 把 Agent 原始回复、Session 对话原文、tool output 或 LLM prompt 持久化到数据库。
3. 将 Generate 改造成允许用户持续追问的聊天产品。
4. 运行中动态增删 Evidence；调整范围需要取消后重新生成。
5. 回滚 Scan 取消前已经完成的 Session 索引和 FS link 写入。
6. 将规则直接写入 Agent system prompt 或 project memory。

## 架构

```text
Renderer
  ├─ Queue active-run entry
  ├─ Run detail / Agent output / Evidence explorer
  └─ Scan progress / cancel
        │ IPC invoke + broadcast event
        ▼
Electron main
  ├─ ScanController ───────┐
  ├─ GenerationController ─┤─ shared BackgroundRun lifecycle
  └─ bounded snapshot      │
        │ Worker message + cooperative cancel
        ▼
Worker
  ├─ Scan Worker → core scanner
  └─ Generation Worker → evidence snapshot → LLM stream → atomic candidate persist
        │
        ▼
Claude Agent SDK / Codex exec --json
```

Scan 与 Generate 可以同时运行。Generate 在启动时读取并冻结本次 Evidence bundles；之后完成的新 Scan 不会改变已经运行中的 Generation。

## 数据模型

不新增数据库表或 schema 版本。`run_metadata.status` 继续使用 TEXT，扩展运行状态值；Generate 使用 `run_type = 'generate-rules'` 写入脱敏后的生命周期摘要。

```ts
type RunState =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'interrupted'

type BackgroundRunStatus<Request, Progress> = {
  runId?: string
  state: RunState
  request?: Request
  progress?: Progress
  startedAt?: string
  endedAt?: string
  error?: string
}

type RunEvent =
  | { runId: string; seq: number; kind: 'phase'; phase: string; at: string }
  | { runId: string; seq: number; kind: 'assistant_delta'; text: string; at: string }
  | { runId: string; seq: number; kind: 'retry'; message: string; at: string }
  | { runId: string; seq: number; kind: 'evidence_ready'; snapshot: EvidenceSnapshot; at: string }
  | { runId: string; seq: number; kind: 'candidate_count'; count: number; at: string }
  | { runId: string; seq: number; kind: 'cancelled' | 'completed' | 'failed'; at: string }

type EvidenceSnapshot = {
  mode: 'recent' | 'changed7d' | 'full' | 'projects'
  rounds?: number
  projects: Array<{
    slug: string
    sessionIds: string[]
    roundCount: number
    excerptCount: number
  }>
  totalSessions: number
  createdAt: string
}
```

GenerationController 在内存中保留：

- 最新状态和 Evidence snapshot；
- 单调递增的 `lastSeq`；
- 最多 200 条非文本生命周期事件；
- 合并后的 Agent output，最多 512 KiB；超过时从头部截断并标记 `outputTruncated`。

原始流式输出不写入 `run_metadata`、`llm_runs` 或 `rule_candidates`。数据库只保存运行摘要、hash、最终候选和既有 evidence 引用。

## 接口设计

### IPC

```ts
window.api.invoke('scan.run', request)
window.api.invoke('scan.status')
window.api.invoke('scan.cancel', { runId })

window.api.invoke('rules.generate', request)
window.api.invoke('rules.generate.status')
window.api.invoke('rules.generate.cancel', { runId })
```

事件通道统一携带 `runId` 和 `seq`：

```text
scan.progress
scan.done
scan.cancelled
scan.failed

generate.event
generate.done
generate.cancelled
generate.failed
```

兼容期保留当前 `generate.progress`，Renderer 完成迁移后只依赖 `generate.event`；CLI 接口不变。

### Core

```ts
type AbortableOptions = {
  signal?: AbortSignal
}

type LlmRequestOptions = {
  fastMode?: boolean
  maxRetries?: number
  signal?: AbortSignal
  onEvent?: (event: LlmStreamEvent) => void
}

type EvidenceOptions = {
  homeDir?: string
  projectSlug?: string
  projectSlugs?: string[]
  sessionIds?: string[]
  rounds?: number
  full?: boolean
  signal?: AbortSignal
}
```

`runScan`、`extractEvidence`、`runRulesGenerate` 和 Provider 调用在 Agent、Session、Evidence bundle、retry 等安全边界检查 `AbortSignal`。

## 子系统设计

### 统一 Run 生命周期

Controller 保持 Scan / Generate 各自的请求与结果类型，但共用相同状态转换和取消行为：

```text
idle → running → completed
              ├→ failed
              └→ cancelling → cancelled
```

- `start` 创建稳定 `runId` 并立即返回。
- 同类型 Run 运行或取消中时拒绝重复启动。
- `cancel` 必须校验 `runId`，避免旧页面取消新任务。
- `cancel` 先向 Worker 发送协作取消；Provider 子进程退出后 Worker 回报 `cancelled`。
- Worker 异常退出仍进入 `failed`；用户主动取消不能显示成错误。
- Renderer 先订阅事件再读取 status，并使用 `seq` 去重和补齐竞态窗口。

### Scan 取消

- Scan Worker 内创建 AbortController，收到 cancel 后触发 signal。
- scanner 在 Adapter、Session、missing 对账和持久化完成边界检查取消。
- 取消时关闭 DB，并把对应 `run_metadata` 更新为 `cancelled`、写入 ended_at 和脱敏 summary。
- 取消记录可以进入 History，但不能被 `loadLatestCompletedScan` 当成 Latest completed scan。
- 已经完成的 Session DB/FS 写入不回滚；History 明确标识该 Run 为 cancelled，避免把部分 summary 当完整结果。

### Evidence snapshot

- Generation Worker 只调用一次 `runRulesGenerate`；Selected projects 通过 `projectSlugs` 一次性提取。
- 所有 Evidence bundles 在第一次 Provider 调用前完成读取，形成不可变 snapshot。
- snapshot 只包含 Project、Session ID 和计数，不包含对话文本。
- Prepare evidence 行可点击，在 Run detail 的 Evidence tab 查看 Project / Session 来源。
- Session 内容继续通过现有 `sessions.preview` 按 source_path 即时读取；UI 根据本次 `rounds / full` 标示哪些最近 rounds 被纳入，不复制到数据库。
- Session 列表沿用固定行高虚拟滚动策略。

### Generate 流式输出

- Claude Agent SDK 启用 `includePartialMessages`，解析 `stream_event` 中的文本 delta；使用 SDK AbortController 停止底层进程。
- Codex 改用 `codex exec --json --ephemeral`，逐行解析 JSONL 事件；prompt 走 stdin，避免 argv 长度限制；取消时 SIGTERM，超时后 SIGKILL。
- Provider 的最终文本继续交给 Zod schema 解析；流式文本仅用于观察，不作为候选规则持久化依据。
- 自动 retry / split 作为同一个 Generation Run 的生命周期事件；内部多个 Provider 请求不会在 UI 中表现为“每个 Project 一次对话”。
- 全部 bundles 成功并通过 schema 校验后，候选规则在现有单个 DB transaction 中一次提交。取消或失败不产生 Draft。

### Renderer 交互

Rules Queue：

- Run 活跃时，Generate 主操作替换为可点击的 `View generation`，不再显示不可操作的 disabled Generate。
- Queue 顶部显示紧凑 active-run strip：Evidence 范围、Provider、运行时间、阶段和 candidate count。
- Sidebar 切换后重新进入 Rules 仍停在 Queue，但运行条始终能进入详情。

Run detail：

- Header 显示 breadcrumb、Run 状态、范围、Provider、耗时和 `Stop generation`。
- 左侧只展示统一阶段：Prepare evidence → Generate candidates → Validate output → Save drafts。
- 右侧提供 `Agent output / Evidence` 两个 tab。
- Agent output 在用户处于底部时自动跟随；用户向上滚动后停止跟随，并提供 Jump to latest。
- Evidence 展示 Project、Session、Agent、状态和本次 rounds 范围；长列表虚拟滚动。
- 完成后保留 summary 和 Agent output，并提供 `Review N drafts`。

Scan：

- 运行态增加 `Cancel scan`；点击后进入 Cancelling。
- New scan 在 running / cancelling 时不可重复启动，但 History 和其他导航保持可用。
- cancelled 状态不覆盖最近成功扫描卡片。

## 安全策略

1. 不持久化 Agent stream、Session 原文、tool output 或 prompt。
2. Evidence preview 继续复用既有脱敏和 tool summary 逻辑。
3. 取消以 runId 精确定位，不接受“取消当前任意任务”的无目标调用。
4. Generate 的部分流式 JSON 永不写入候选表。
5. Codex generation 使用 ephemeral、read-only sandbox 且不加载项目 rules，避免 Evidence 生成任务产生外部修改。

## 改动范围

- `packages/app/main/scan-controller.ts`：补 Run ID、完整状态机和取消。
- `packages/app/main/generation-controller.ts`：补事件序号、输出 snapshot、Evidence snapshot 和取消。
- `packages/app/main/scan-worker.ts`：接收协作取消并传递 AbortSignal。
- `packages/app/main/generation-worker.ts`：单次 Evidence snapshot、流式事件和协作取消。
- `packages/app/main/ipc.ts`：注册 cancel/status/event IPC。
- `packages/core/src/scanner.ts`：AbortSignal、安全检查点和 cancelled metadata。
- `packages/core/src/evidence.ts`：多 Project scope、AbortSignal 和 snapshot 来源。
- `packages/core/src/commands/rules-generate.ts`：流式回调、单次生成事务和取消传播。
- `packages/core/src/llm.ts`：Claude partial event、Codex JSONL、Provider abort。
- `packages/app/renderer/src/types.ts`：Run / event / Evidence 类型。
- `packages/app/renderer/src/views/OverviewView.tsx`：Scan cancelling / cancel UI。
- `packages/app/renderer/src/views/RulesView.tsx`：active-run strip、Run detail、stream replay、Evidence explorer。
- `packages/app/test/`、`packages/core/test/unit/`：先补状态机、取消、流式、snapshot 和 UI 契约测试。
- `memory/process.md`：完成后同步实现决策和验收结果。

不修改 `test/sources/<agent>/`，不回滚工作区现有未提交改动。

## 假设

- ⚠ 用户可见的“一次连续 Agent Run”是统一的任务与时间线，不要求底层永远只有一次 Provider API/CLI 请求；上下文拆分和 retry 可以产生多个内部请求。
- ⚠ Scan 取消前已完成的 Session 索引与 FS link 可以保留；产品只保证 cancelled Run 不成为 Latest completed scan，不提供跨 DB/FS 的回滚。
- ⚠ App 退出后当前 Run 标记为 interrupted 即可，不要求重新启动 Provider 子进程或恢复原始流式文本。

## 风险

- Claude 与 Codex 的原始事件形态不同，直接把 Provider payload 透传到 Renderer 会形成强耦合；必须在 core 归一化事件。
- 高频 token delta 会造成 IPC 和 React 渲染压力；Worker/Controller 合并小 delta，Renderer 按 animation frame 批量更新。
- Worker 被强制终止时 Provider 子进程可能残留；优先协作 abort，并保留超时 kill 与进程退出检查。
- Scan 已经边扫边写 DB/FS，取消后的 Project 视图可能包含本次已处理部分；History 和 Latest 必须明确区分，避免用户误判为完整扫描。
- 旧 Electron main 与热更新 Renderer 可能再次产生 IPC handler 版本漂移；缺少 cancel/event handler 时继续显示可理解的重启提示。

## 验收链路

定向测试：

```bash
npm test -w @memory-manager/app -- --runInBand scan-controller generation-controller background-run
npm test -w @memory-manager/core -- --runInBand scan llm evidence rule-candidates-generate
```

全量验证：

```bash
npm test -w @memory-manager/app
npm test -w @memory-manager/core
npm run build -w @memory-manager/core
npm run build -w @memory-manager/app
git diff --check
```

必须证明：

1. Scan / Generate start 都立即返回，应用在运行中可以切换导航和主题。
2. 切出 Rules 再回来，Queue 显示同一 runId 的运行条，View generation 能打开已累积输出。
3. Claude/Codex 模拟流式测试都能逐段产生 assistant delta，最终结果仍通过 schema 校验。
4. Stop generation 会结束 Provider 子进程并进入 cancelled，Candidate 表没有新增 Draft。
5. Cancel scan 会停止后续 Session 处理，History 可识别 cancelled，Latest 仍返回上一次 success/partial。
6. Generate 启动后的 Evidence snapshot 不受并发 Scan 后续结果影响。
7. Evidence explorer 能查看 Project / Session 来源并打开脱敏 Session preview。
8. App/Core 全量测试、production build 和 diff check 通过。

## 后续实现顺序

1. 先用测试锁定统一 Run 状态、runId、seq、取消与重挂载恢复的端到端最小骨架。
2. 给 scanner / evidence / rules-generate 增加 AbortSignal 和不可变 Evidence snapshot。
3. 接入 Claude partial events、Codex JSONL events 和真实 Provider abort。
4. 扩展 Worker / Controller / IPC 的事件重放、取消和 interrupted 处理。
5. 实现 Rules Queue active-run strip、Run detail、流式输出与 Evidence explorer。
6. 实现 Scan cancelling UI、cancelled History 与 Latest completed 兼容。
7. 完成真实 Electron smoke、全量回归并同步 `memory/process.md`。

## 回归点

- CLI `scan`、`rules generate` 参数和标准输出行为保持兼容。
- Recent / Changed in last 7 days / Full / Selected projects 四种 Generate 范围保持可用。
- Scan History 既有 success/partial 记录仍可解析。
- Projects / Sessions 虚拟列表、Settings Provider 与 Output Rules 不受影响。
- Node 与 Electron 的 better-sqlite3 ABI 隔离保持不变。

## 参考

- `DESIGN.md`
- `memory/process.md`
- `packages/app/main/scan-controller.ts`
- `packages/app/main/generation-controller.ts`
- `packages/core/src/scanner.ts`
- `packages/core/src/commands/rules-generate.ts`
- `packages/core/src/llm.ts`
- [Paseo client timeline](https://github.com/getpaseo/paseo/blob/main/packages/client/src/index.ts)
- [Paseo session store](https://github.com/getpaseo/paseo/blob/main/packages/app/src/stores/session-store.ts)
- [Claude streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
