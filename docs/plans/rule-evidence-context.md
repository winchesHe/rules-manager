# 候选规则来源会话上下文

## 范围与验收标准

- 候选规则审核页不再直接展示技术性的 Evidence locator JSON。
- 每条 Evidence 引用展示来源 Agent、Session、时间，以及命中消息前后的脱敏会话上下文。
- 上下文只在打开审核页时从既有 `source_path` 按需读取；不把会话原文、Prompt、工具参数或工具结果写入 DB / Chat。
- 历史引用或源文件不可用时显示明确降级信息，不让整个审核页失败。

## Step 1：建立 locator 与窗口读取的最小骨架

- 单一改动：解析结构化 / 旧版 locator，并在 Core 中按原始 `messageIndex` 返回固定窗口。
- 观察点：测试结果能看到命中消息带 `matched=true`，相邻消息保留原始索引。
- 验证方式：运行 Core Evidence 单测和 Renderer view-model 单测；确认脱敏内容存在、工具参数与结果不存在。

## Step 2：接通按需 IPC

- 单一改动：扩展 Session Preview Worker，增加 `sessions.evidenceContext` handler。
- 观察点：Renderer 只传 `sessionId + messageIndex`，Worker 返回脱敏窗口。
- 验证方式：运行 App IPC / build entry 契约测试，并验证非法 locator 被主进程拒绝。

## Step 3：替换审核页 Evidence 展示

- 单一改动：用“来源会话与上下文”列表替换 locator JSON 与空的来源会话字段。
- 观察点：每个来源卡片展示 Agent、时间、Session ID；命中消息有清晰高亮，前后消息保留角色。
- 验证方式：运行 App 视图契约测试并构建 Renderer；缺失引用显示明确空态，单条加载失败只影响对应来源。

## Step 4：全量验收与同步

- 单一改动：同步 `DESIGN.md` 与 `memory/process.md`，完成项目级回归。
- 观察点：隐私边界和历史兼容决策可从文档追溯。
- 验证方式：`npm test`、Core/App production build、`git diff --check` 全通过。
