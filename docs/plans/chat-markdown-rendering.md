# Chat Markdown 流式渲染

## 改动范围

- 使用 React 技术栈对应的 `markstream-react`，不引入 Vue runtime 或 `markstream-vue`。
- Native Chat 的历史 Assistant 消息与运行中 Assistant 输出统一使用流式 Markdown 渲染。
- Rules Generation 的 Assistant 终态摘要同步使用 Markdown 渲染；用户消息继续按纯文本展示。
- Markdown 样式适配现有 dark/light token，不改变 Tool Activity、复制按钮和耗时区域。
- 保持原始 Markdown 文本作为复制内容，不把渲染 HTML 写入 ChatStore。

## 观察点

1. `##` 标题、无序/有序列表、行内代码、代码块、引用和链接呈现为对应语义，不再显示 Markdown 标记。
2. 流式响应在 Markdown 未闭合时仍可稳定显示，完成后切换为 final 状态。
3. 长单词、宽代码块与表格不撑破 820px 对话阅读线，内部可滚动或换行。
4. 用户气泡、Tool Activity、复制原文和耗时展示保持现有行为。

## 验证方式

- Renderer 契约测试覆盖历史、流式和 Rules Assistant 三条 Markdown 渲染路径，并确认用户消息仍为纯文本。
- App 全量测试与 typecheck、App/Core production build、`git diff --check`。
- 使用真实 Electron 会话做视觉验证，确认截图中的标题、列表与行内代码完成渲染。
