# Agent Dashboard 侧栏主导航条目间距

## 范围

- 只调整侧栏「工作区」分组中 Scan / Projects / Chat 三个主导航条目的垂直间距。
- 保持条目高度、选中态、图标、文字、点击热区、分组间距与侧栏收起行为不变。

## 观察点

- 选中态胶囊与上下相邻条目之间有清楚且一致的留白，不再显得贴合。
- 三个主导航条目的节奏一致，选中 Scan / Projects / Chat 时布局不跳动。
- 展开态与收起态都不出现横向溢出或对齐回归。

## 验证方式

- 运行 App Shell 定向测试，确认导航结构与侧栏折叠合同不变。
- 运行 Electron production build。
- 在真实 Electron 中分别检查展开态、收起态以及 Projects 选中态。
- 运行 `git diff --check`。
