# Chat 工具活动分组

## 目标

将 Native Chat 中逐条平铺的 Tool activity 改为 Codex 风格的渐进展示：同一段连续工具调用先显示一行分类摘要，默认收起；用户展开组后查看逐条调用，再按需展开单条详情。

## 改动范围

- 只调整 Renderer 的 timeline 呈现模型、Chat 组件与中英文文案。
- 保留 Provider 首次事件顺序；Assistant 正文与 Thinking 都是分组边界，不跨越它们合并 Tool。
- 历史消息的 `timeline` 与旧 `toolActivities` fallback 都使用相同分组组件。
- 不改变 Native Session、IPC、ChatStore、Tool input/output 持久化或回源策略。
- 保留现有运行中原位更新；组摘要显示运行中与失败状态。

## 观察点与验收标准

1. 连续的 Read / Search / Shell / Tool 形成一个组；中间出现 Assistant 或 Thinking 时必须断组。
2. 组头使用分类计数摘要，例如“读取 3 个文件，运行 2 条命令”，而不是拼接原始 payload。
3. 完成态组默认收起；展开组后仅显示安全的单行 Activity 摘要，继续展开单条时才按现有回源链读取详情。
4. 运行中的组在组头显示 Spinner；失败组自动暴露逐条列表并显示失败数量，失败信息不能被静默折叠。
5. 展开按钮具有 `aria-expanded`，鼠标 hover、键盘 focus 和图标旋转均有明确反馈。
6. 刷新前后 timeline 顺序不变；本轮不向 ChatStore 新增任何 Tool 内容字段。

## 验证方式

- `chat-timeline-model.test.ts`：验证连续分组、分组边界、原顺序和活动引用。
- Chat 布局契约测试：验证分组容器、默认折叠、可访问属性和旧消息 fallback 仍存在。
- App 定向测试与全量测试。
- App production build。
- 真实 Electron 暗色界面检查：组头摘要、默认收起、展开层级、运行/失败视觉状态和横向溢出。

