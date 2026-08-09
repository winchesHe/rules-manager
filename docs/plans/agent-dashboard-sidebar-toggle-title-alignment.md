# Agent Dashboard 侧栏按钮与页面标题对齐

## 范围

- 只调整全局侧栏折叠按钮在不同页面骨架中的垂直位置。
- 不修改折叠状态、侧栏宽度、导航、主题、PageHeader 内容或 Chat History 布局。

## 观察点

- 普通页面的主容器使用 `py-12`，Page Title 从内容区顶部开始；按钮固定在 `top: 0.5rem` 时停留在窗口顶栏，
  与 Title 错开一行。
- Chat 和 Settings 自带固定顶栏，仍需要保留原 `top: 0.5rem` 位置，不能统一下移。

## 验证方式

- App Shell 与拖拽合同测试锁定 `topbar` / `page-title` 两种定位类及路由条件。
- Computer Use 检查 Scan、Projects、Rules 的标题对齐，并复查 Chat / Settings 顶栏位置。
- App 全量测试和 production build 验证无行为回归。

## 验收标准

- Scan、Projects、Rules 等普通页面中，按钮与 Page Title 位于同一水平层级。
- Chat、Settings 中按钮仍与固定顶栏同层，不与 History 或设置导航重叠。
- 展开和收起侧栏后定位规则一致，热区保持可用。
