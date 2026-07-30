# APP Chat 一级导航与 Rules Generation Thread

## 背景

Rules Generate 已经具备后台 Worker、流式事件、Evidence snapshot、结构化 Candidate 和历史摘要，但运行详情仍属于 Rules 页面，Agent 可见正文只保存在主进程内存中。页面切换后可以恢复当前进程内状态，App 重启后只能恢复 `run_metadata` 摘要，无法恢复用户实际看见的对话正文。

本轮把 Chat 提升为一级导航，并将 Rules Generation 表现为一个可持久化的 Chat Thread。Rules 继续拥有 Candidate 审核与发布；Chat 拥有生成请求、执行过程和结果展示。

## 第一版范围

### 包含

- 新增 `Chat` 一级导航与独立 Chat 页面。
- Rules Start Generate 仍在 Rules 中选择 Evidence scope；成功启动后切换到对应 Chat Thread。
- Chat 展示 Thread 列表、Paseo 风格 Request / Assistant 对话、阶段、Activity、Evidence、Candidate Artifact 与 Run context。
- 页面切换后恢复当前 Run；App 重启后从本地文件恢复完整可见正文、Evidence、Activity 摘要与 Candidate Artifact。
- Generation History 作为 Chat 的历史来源；新 Run 进入可恢复 Thread，旧 Run 以只读摘要安全降级。
- 完成后从 Chat 进入 Rules / Generated rules 审核。
- 流式 Assistant 正文定期 checkpoint；中断后保留已经写入的部分并标记 `interrupted`。

### 不包含

- 通用 New chat。
- Composer、连续追问或 Session Summary。
- 多 Context 组合与 Context 版本快照。
- 持久化隐藏 Prompt、Session 原文、tool 参数、tool output 或 raw token event。

## 数据与隐私边界

Chat 是用户主动创建的产品数据，允许在本地 workspace 中持久化用户可见正文和结构化 Artifact。导入的 Agent Session 仍是只读数据源，不复制进 Chat。

```text
<workspace>/chats/
└── <thread-id>/
    ├── thread.json
    ├── messages.jsonl
    └── assistant.partial.json
```

- `thread.json`：Thread 元数据、Run 状态、request、Evidence、可见 Activity 摘要和 Candidate Artifact。
- `messages.jsonl`：已完成的用户/Assistant 可见消息，只追加。
- `assistant.partial.json`：当前流式 Assistant 消息的原子 checkpoint；Run 完成、失败或取消时转为最终消息并移除。
- SQLite 不保存 Chat 正文；第一版直接扫描 `chats/` 获取 Thread 索引，避免新增 schema。
- Session Context 后续只保存 `sessionId`，每次调用读取最新 Session 内容。

## 信息所有权

```text
Rules
  ├─ 选择 Evidence scope
  ├─ 审核 Candidate
  └─ 发布 Rules

Chat
  ├─ Generation Thread 列表
  ├─ Request / Assistant 正文
  ├─ Run Activity / Evidence
  └─ Candidate Artifact → Open generated rules
```

Rules 中的现有 Generation history 入口保留为过渡快捷入口，但打开详情时进入 Chat；不再维护第二套 Generation Run 详情。

## 可执行步骤

### 1. 搭出 FS-first Chat 最小存储骨架

只新增 workspace `chats/` 路径与 Generation Thread store，支持创建、列举、读取、流式正文 checkpoint 和终态 finalize。

观察点：

- 隔离 workspace 中启动一次 Thread 后出现 `chats/<run-id>/thread.json`、`messages.jsonl`。
- 流式过程中出现 `assistant.partial.json`。
- 完成后 partial 消失，Assistant 最终正文进入 `messages.jsonl`。

验证方式：

- 单元测试覆盖创建、读取、排序、原子 checkpoint、完成、中断和损坏 Thread 隔离。
- `init --non-interactive` 会幂等创建 `chats/`。

### 2. 将 GenerationController 状态同步到 Chat Thread

只在现有 Controller 生命周期中增加 Chat 持久化，不改变 Provider、Worker、Evidence 提取和 Candidate 事务语义。

观察点：

- `start` 创建与 `runId` 同 ID 的 Thread。
- `project_response` 到达时增量更新可见 Assistant 摘要、Artifact 和 partial 正文；`assistant_delta` 仍只用于进程内 Diagnostic，不写入 Chat。
- Evidence、阶段、Project response 和终态同步到 Thread。
- App 启动时遗留 running/cancelling Thread 进入 interrupted。

验证方式：

- Controller 测试使用临时 Chat store，覆盖 running → completed / cancelled / failed / interrupted。
- 既有 Controller 状态机测试保持全绿。

### 3. 新增 Chat 一级页面与最小端到端导航

只实现 Thread Rail、对话区和 Run context；不增加 Composer。

观察点：

- 主导航出现 Chat。
- Chat 默认打开当前运行 Thread，否则打开最近 Thread。
- Rules 启动成功后自动切换 Chat，并选中对应 Thread。
- Request 在右侧气泡，Assistant 使用无气泡正文；Candidate 使用结构化 Artifact。

验证方式：

- Renderer 布局契约测试锁定 Chat 一级导航、三段布局和无 Composer。
- IPC 测试锁定 `chat.list / chat.read`。
- 真实窗口验证 Rules → Generate → Chat 跳转和窄窗口无页面级横向溢出。

### 4. 收口 History、重启恢复与审核出口

只统一 Run 详情所有权，不重做 Candidate 审核页面。

观察点：

- 新 Generation History 行打开对应 Chat Thread。
- 旧 Run 没有 Thread 时显示摘要降级。
- Chat 完成态提供 `Open generated rules`。
- App 重启后正文、Evidence 和 Artifact 与退出前一致。

验证方式：

- 历史兼容测试覆盖有 Thread / 无 Thread 两种记录。
- 隔离 workspace 完成生成存储 smoke，重启主进程后通过 `chat.read` 对账正文。

### 5. 全量回归与上下文同步

观察点：

- Scan、Projects、Rules 审核发布和 Settings 不因主导航及 IPC 扩展回归。
- Chat 不持久化 Prompt、Session 原文、tool 参数或 tool output。

验证方式：

- `npm test`
- `npm run build`
- Renderer 扩大 `rootDir` TypeScript 检查
- `git diff --check`
- 将最终事实和遗留 debt 追加到 `memory/process.md`

## 第一版验收链路

```text
Rules 点击 Start Generate
→ 选择 Evidence scope
→ 创建 Chat Thread
→ 自动切换并选中 Chat
→ 流式看到 Agent 输出
→ 切到 Projects 再返回，状态仍在
→ 完成后看到 Candidate Artifact
→ 重启 App，完整可见正文仍可阅读
→ 点击 Open generated rules，进入 Rules 审核
```

## Follow-up：Paseo P1 流式 Activity 与完成态 Rules（2026-07-30）

本轮以 Paseo P1 的 Agent Stream 为交互参考，但只复用适合 Rules Generation
的最小语义：Provider 事件先归一化为 Activity，再由 Chat 增量展示。不会把
Provider 原始 event、tool input 对象或 tool output 直接交给 Renderer。

### 1. 固定 Chat 工作区高度

只调整 Chat 页容器与三个内部滚动区，不改变其他一级页面。

观察点：

- Chat 页面高度固定为当前 viewport 扣除页面 padding 后的可用高度。
- Thread Rail、Conversation、Run context 各自滚动，页面本身不随消息增长。
- 窄窗口不出现页面级横向滚动。

验证方式：

- Renderer 布局契约测试锁定 `h-[calc(100vh-4rem)]`、`overflow-hidden` 和
  三个 `min-h-0 / overflow-y-auto` 内部滚动区。
- 真实 Electron 窗口分别验证桌面宽度和窄窗口。

### 2. 打通 Provider → Worker → Controller → Chat Activity 最小链路

只新增结构化 `activity` 流事件，类型限定为 `thinking / read / search /
shell / tool`。Claude 从 reasoning/tool-use 消息归一化，Codex 从 JSONL
item 事件归一化；未知结构安全忽略。

观察点：

- Agent 运行时逐行出现 Thinking、Read、Search、Shell 等上下文。
- 每行只展示动作名称和经过截断的单行摘要。
- tool output、原始 input 对象、隐藏 Prompt 和 raw assistant JSON 不进入
  Chat 文件。

验证方式：

- Core 单元测试覆盖 Claude 与 Codex 典型事件、未知事件和摘要截断。
- Worker / Controller 测试覆盖 activity 转发、retain 和 defensive copy。
- ChatStore 测试覆盖可见摘要恢复，并断言 tool output / raw output 不落盘。

### 3. Paseo 风格 Timeline、计时与自动跟随

只重做 Assistant Turn 内的 Activity 展示，不增加 Composer 或通用聊天能力。

观察点：

- Activity 默认展开为无卡片的紧凑时间线，不再藏在 `<details>`。
- 运行中底部显示同步 loading 标记和从 `startedAt` 计算的 elapsed time。
- 用户位于底部附近时新 Activity 自动跟随；主动上滚后保持阅读位置。

验证方式：

- 纯函数测试覆盖 elapsed 格式与“接近底部才跟随”的判定。
- Renderer 契约测试锁定 Activity 行和滚动锚点。
- 真实运行或隔离事件回放验证增量追加与滚动行为。

### 4. Rules 只在 Run 完成后一次性展示

Controller 仍可逐项目接收并 checkpoint 结构化响应，但 Renderer 在
`thread.status !== completed` 时不渲染任何 Candidate Artifact。

观察点：

- running / cancelling / failed / cancelled / interrupted 均不显示半成品 Rules。
- completed 后同一帧显示该 Run 的全部 Candidate。
- completed 且无 Candidate 时显示明确空状态。

验证方式：

- 视图模型单元测试覆盖所有 Thread 状态的可见 Candidate 集合。
- ChatStore / Controller 既有增量 checkpoint 测试保持通过，证明只改变展示
  时机，没有破坏完成数据。

### 5. 全量回归与上下文同步

观察点：

- Chat 切换、重启恢复、Rules 审核出口和 Generation History 不回归。
- 新旧 Thread 均可读取；旧 Activity 缺少结构化字段时安全降级。

验证方式：

- `npm test`
- `npm run build`
- Renderer TypeScript 检查
- `git diff --check`
- Electron 真实窗口验收后追加 `memory/process.md`

## Follow-up：Activity 可读性修正（2026-07-30）

用户真实运行反馈暴露两个问题：Assistant 头像、标题和状态重复占位；Claude
stream 只把 thinking start 保存为无正文行，且页面过滤掉 Generation pipeline
事件，因此没有 tool call 的 Run 看起来永远只有不可展开的 Thinking。

### 1. 精简 Assistant Turn 外壳

观察点：

- 移除 Assistant 头像、`Assistant` 标题和重复状态 Chip。
- Request、Activity timeline、完成态摘要和 Candidate 继续保持原有顺序。

验证方式：

- Renderer 契约测试禁止 `Bot`、`t('assistant')` 和 `statusColor` 出现在
  `PersistedConversation`。
- Electron 真实窗口确认 Activity 与 Request 使用同一内容轴。

### 2. Thinking 生命周期与可展开正文

观察点：

- Claude `thinking_delta` 在 content block stop 时形成 completed Activity，
  保留 provider 明确输出的 thinking 正文。
- Codex completed reasoning item 同样形成带正文的 completed Activity。
- 同一 Activity 的 running / completed 更新合并为一行；点击带正文的行可以展开
  或收起，不再重复堆积同名 Thinking。

验证方式：

- Core 单元测试覆盖 thinking start → delta → stop 与 Codex reasoning completed。
- ChatStore / View model 测试覆盖按 Activity id 合并和旧 Thread 重复行降级。
- Renderer 契约测试锁定可点击 Activity row、展开状态和 `whitespace-pre-wrap`。

### 3. 无 tool call 时展示真实 Generation pipeline

Rules Generation 的模型输入已经包含 Evidence，Provider 不一定需要调用 Read /
Search / Shell。不能伪造 tool use；改为同时展示真实 pipeline：

- `evidence_ready` → Collect
- `progress` → Analyze
- `project_response` → Draft
- `candidate_count` → Validate
- `retry` → Retry

观察点：

- 有真实 tool use 时继续显示 Read / Search / Shell。
- 无 tool use 时仍可看到 Collect / Analyze / Draft / Validate 的实际进度。
- Candidate 正文仍严格在 Run completed 后一次性出现。

验证方式：

- Controller 测试确认 progress 被保留为 phase event。
- ChatStore 测试确认 pipeline event 映射和可恢复。
- running / completed 真实回放继续对账 Candidate 门控。
