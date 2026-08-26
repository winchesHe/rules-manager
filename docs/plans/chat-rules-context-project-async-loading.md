# Rules Chat 上下文同步与项目异步加载

## 目标

- 从 Rules 入口创建的 Native Chat 在规则证据确定后，右侧 Session Context 自动勾选同一批 Session。
- 打开包含大量 Session 的项目时，Session 名称解析不阻塞 Electron 主进程，窗口仍可响应交互。

## 设计对齐

- Rules 生成流程仍以 `onEvidence` 产出的引用作为唯一上下文来源，不在 Renderer 重算“最近 7 天”或项目范围。
- Chat 切换时同步 Provider、模型等会话配置；同一 Chat 的上下文 revision 变化时只同步 Session Context，避免覆盖用户正在编辑的运行参数。
- `projects.sessions` IPC 的返回结构和 Renderer 调用方式保持不变，仅把同步 Core 查询放进独立 Worker。

## 观察点与验证方式

1. Rules Chat 上下文
   - 观察点：同一 thread id 的 `sessionContext.revision` 更新后，Composer 计数和右栏勾选同步变化。
   - 验证：增加 ChatView 源码契约回归，并在真实 Electron 中检查已有/新建 Rules Chat。
2. 项目详情加载
   - 观察点：`projects.sessions` 通过独立 Worker 执行，Worker 的成功、业务错误、异常退出均能结束 IPC Promise。
   - 验证：增加 IPC/构建入口契约回归；打开大项目时检查加载期间窗口可交互，完成后列表正常展示。
3. 回归
   - App/Core 全量测试、production build、`git diff --check`。

