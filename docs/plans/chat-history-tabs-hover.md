# Chat 历史 Tab Hover 修复

## 范围

- 为「当前 / 归档」两个历史筛选 Tab 补充整块 hover 反馈。
- 保持现有选中态、切换逻辑、尺寸和布局不变。
- 同步补充键盘 focus-visible 反馈。

## 观察点与验收

1. 未选中的 Tab hover 时出现 `surface-hover` 背景，文字切换为前景色。
2. 两个 Tab 的交互热区、圆角和视觉反馈一致。
3. 选中态仍使用 `surface-raised`，不受 hover 样式覆盖。
4. 暗色和浅色主题下反馈均清晰可见。

## 验证方式

- 更新 Chat 历史头部布局契约测试。
- 运行 App 定向测试与 production build。
- 在真实 Electron 中检查未选中 Tab 的 hover 效果。
