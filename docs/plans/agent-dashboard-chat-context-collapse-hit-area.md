# Agent Dashboard Chat Context 收起按钮热区修正

## 范围

- 只调整 Chat 右侧 Session Context 标题栏「收起」按钮的可点击区域。
- 不修改 Context 开关状态、窄屏 Drawer、Session 选择、主题或其他 Chat 操作。

## 观察点

- 全局窗口拖拽层覆盖顶部 2rem 且层级为 1000；Context 按钮虽然声明 `no-drag`，自身却处于拖拽层下方，导致
  视觉按钮的大部分区域被透明拖拽层截获，只有下沿可以稳定点击。
- Context Pane 的位移动画会创建独立 stacking context，因此只提高按钮自身层级无法越过根级拖拽层；需要把
  Pane 根层级抬到 1001，再由按钮自身声明 `window-no-drag`。
- 现有按钮只有 2rem 高，标题栏固定为 3rem，按钮上下还存在看似属于控件、实际无法点击的空隙；按钮宽度也只
  由图标、文字和较小内边距决定，视觉标签附近的容错不足。

## 验证方式

- 合同测试锁定 Context Pane 根层级高于拖拽层，并锁定按钮使用 `window-no-drag`、占满标题栏高度、固定横向
  内边距和独立右侧单元。
- App 全量测试与 production build 验证没有影响 Chat 布局和行为。
- Computer Use 在真实 Electron 中验证按钮上沿、中心、下沿都能收起 Context，按钮左侧标题区域不触发收起；
  同时检查浅色与深色 hover/布局边界。

## 验收标准

- 「收起」按钮位于窗口拖拽层之上，热区覆盖其所在标题栏的完整高度，并扩大左右容错。
- 热区不进入「Session 上下文」标题与数量区域，不越过右侧 Pane 边界。
- 点击按钮仍只执行关闭 Session Context，不改变其他 Chat 状态。
