# Agent Dashboard 知识库导航收敛

## 目标

移除「规则」父项下再嵌套分组标题和页面入口的三级视觉关系，把知识库导航改为接近 P2 的两组 Disclosure：
「规则管理」与「Agent 上下文」。两组默认展开，四个真实页面无需额外点击即可看到。

## 范围

- Workspace 继续保留 Scan / Projects / Chat，不改变对应页面或路由行为。
- Knowledge 直接展示「规则管理」「Agent 上下文」两个带图标和箭头的可折叠父级。
- 「概览 / 规则工作台」「Agent 指令 / Agent Memory」作为紧凑叶子项，通过左侧细竖线表达从属关系。
- 只有当前叶子项显示选中底色；父级只用文字颜色表达当前分组，不显示选中胶囊。
- 两组初始状态均为展开；内部跳转到 Rules 页面时，自动确保目标所在分组展开。
- 保留 Rules 内部 `ViewId`、现有业务页面、固定高度侧栏、设置入口和深浅主题。

## 观察点与验证方式

| 观察点 | 验证方式 |
|---|---|
| 首次进入时四个知识库叶子全部可见 | App Shell 合同测试 + Electron 视觉检查 |
| 两个父级可分别折叠和展开，箭头方向与内容状态一致 | `aria-expanded` 合同测试 + Electron 交互检查 |
| 叶子切换仍进入正确 Rules section，当前页是唯一选中行 | App 导航合同测试 + Electron 交互检查 |
| Projects / Chat 跳入 Rules 时目标分组会重新展开 | 状态与回调合同测试 + App 全量测试 |
| 深浅主题、底部设置和主题快捷按钮没有变化 | theme / App Shell 测试 + Electron 双主题检查 |
| 固定高度侧栏在内容增加后仍只在导航区内部滚动 | 源码合同测试 + Electron 视觉检查 |

## 不在本轮

- 不重命名 Rules 内部 section id、IPC 或持久化数据。
- 不修改 Rules 页面主体布局和业务流程。
- 不修改现有主题 token、Settings 或 Workspace 导航行为。
