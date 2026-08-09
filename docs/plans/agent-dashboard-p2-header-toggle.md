# Agent Dashboard P2 式 Header 侧栏开关

## 范围

- 移除侧栏开关的绝对定位和独立空白轨道。
- 将侧栏开关改为 Header leading control，与竖分隔线、当前页面标题处于同一布局层级。
- 普通页面复用 `PageHeader`，Chat 与 Settings 在各自固定 Header 中使用相同控件。
- 不修改侧栏宽度、折叠状态、导航、主题、页面内容或 Chat History 布局。

## 观察点

- 独立悬浮按钮虽能与标题垂直对齐，但缺少结构归属，并在主内容左侧形成无意义的按钮轨道。
- P2 的正式模式是把侧栏开关作为顶栏 leading control，使用分隔线连接当前内容上下文。
- Chat 和 Settings 拥有独立固定工作区，需要共享按钮行为，但不能强行套用普通页面高度。

## 验证方式

- App Shell、拖拽与页面布局合同测试锁定 Provider、Header leading control、分隔线和 no-drag 热区。
- Computer Use 检查 Scan、Chat、Settings 的标题关系，以及展开、收起和深浅主题。
- App 全量测试与 production build 验证无行为回归。

## 验收标准

- 主内容区不再出现独立按钮轨道或绝对定位的侧栏开关。
- Scan 等普通页面中，按钮、分隔线与 Page Title 位于同一个 Header 布局流。
- Chat、Settings 中按钮与各自标题同层，且不与 History、窗口拖拽区或设置导航重叠。
- 展开和收起侧栏后按钮位置稳定、热区完整，主题 token 保持不变。
