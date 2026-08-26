# Chat 失败任务重新生成

## 范围与验收

- 失败、已取消或被中断的规则生成 Chat Thread 提供“重新生成”。
- 重新生成完整复用原 Thread 的 Evidence 范围、项目选择与 Agent 运行配置。
- 每次重新生成创建新的 Run / Chat Thread，旧记录保持只读且可继续查看。
- 运行中、正在取消和已完成的 Thread 不展示该操作；已有 Run 占用生成器时不重复创建。

## Step 1：定义终态操作资格

- 改动：增加可重试状态纯函数，并在 Chat 布局契约中固定入口、调用和状态范围。
- 观察点：`failed / cancelled / interrupted` 返回可重试，其余状态返回不可重试。
- 验证方式：运行 `chat-view-model.test.ts` 与 `home-workflow-layout.test.ts`，测试先失败后通过。

## Step 2：复用请求创建新 Run

- 改动：点击“重新生成”时把当前 Thread 的 `request` 交给既有 `rules.generate` IPC；成功后刷新并选中新 Run。
- 观察点：新 Thread 出现在列表顶部并立即进入运行态，旧 Thread 仍可选中。
- 验证方式：Renderer 布局契约检查请求复用、新 Run 跳转、loading 防重与错误反馈；App build 验证类型和打包链路。

## Step 3：回归验收

- 改动：补齐中英文文案并同步实现上下文。
- 观察点：成功态继续只显示“打开生成的规则”，运行态继续只显示停止操作。
- 验证方式：App / Core 全量测试、production build 与 `git diff --check`。
