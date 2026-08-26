# Chat 历史复制原生 Session ID

## 背景

Chat 历史已经通过右键菜单提供重命名、置顶和归档操作，但排查 Agent 会话时无法直接取得底层原生
Session ID。用户只能再去本地文件或数据库中查找，操作链路不完整。

## 设计对齐

- 在既有 Chat 历史操作菜单和当前对话顶部的管理菜单中增加“复制 Session ID”，不在紧凑历史列表中常驻
  新按钮。
- 复制 `NativeChatThreadSummary.nativeSessionId`，不使用本地 `thread.id` 冒充 Agent Session ID。
- 原生 Session 尚未创建时禁用复制操作并显示明确文案。
- 复制成功后展示短暂的可访问成功反馈和实际 ID；失败进入既有操作错误提示，不静默吞错。
- 当前与归档列表共用同一操作菜单，因此能力同时覆盖两种状态；旧版只读记录保持原有行为。

## 验证方式与验收标准

- 合同测试确认历史菜单包含复制入口、使用 `nativeSessionId`、调用 Clipboard API，并覆盖成功与失败反馈文案。
- App 全量测试和 production build 通过，`git diff --check` 通过。
- 真实 Electron 中对一条已有原生 Session 的历史记录打开菜单，复制后可见成功反馈；剪贴板内容与菜单所属
  Thread 的 `nativeSessionId` 一致。
