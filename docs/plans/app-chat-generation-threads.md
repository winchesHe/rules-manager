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
