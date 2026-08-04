# Chat 输入栏无边框控件

## 改动范围

- 仅调整 Chat 输入栏底部工具栏的视觉样式。
- 上下文按钮、Provider、Model、Effort Picker 与 Fast 控件统一为无静态描边、无静态阴影。
- 保留现有尺寸、排布、选择逻辑、禁用状态、Popover、Switch 和发送行为。

## 观察点与验证方式

1. 静止状态不出现独立输入框式描边或阴影，工具栏视觉上属于同一平面。
2. hover 使用轻量背景反馈；键盘 focus 继续由组件自身 focus ring 表达。
3. Fast 的开关本身仍明确表达开关状态，发送按钮仍保持主操作强调。
4. 运行 App 布局契约测试和 production build；在真实 Electron Chat 页面截图确认控件边界与状态。

