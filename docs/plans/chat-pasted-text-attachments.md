# Chat 长文本粘贴附件与 Composer 右侧布局修复

## 改动范围

- Codex Composer 粘贴不少于 5,000 个 JavaScript 字符时，立即转换为可见文本附件卡。
- 附件正文只保留在 Renderer 当前草稿内；发送时经 IPC 交给 Main，Main 临时落盘并以 App Server
  `mention` 提交，Turn 结束后删除，不写入 ChatStore。
- ChatStore 只保存附件名称与字符数，用于已发送用户消息的附件卡回显。
- 修复 textarea 原生滚动条越过 Composer 圆角，以及底部运行配置挤压右侧固定操作区的问题。

## 验收标准

- Codex 下粘贴 4,999 字符保持正文；粘贴 5,000 字符立即出现附件卡且 textarea 不含该段正文。
- 纯附件可以发送；发送前可移除，25,000 字符以内可放回输入框。
- `turn/start.input` 包含精简文本指令和 `mention`；临时文件在 Turn 期间可读，成功或失败后删除。
- 已发送消息只持久化附件元数据，不持久化附件正文。
- Composer 右边框与圆角完整；textarea 滚动条被外壳裁剪；运行配置缩小时不侵占权限、用量和发送区。

## 验证方式

- 纯函数测试覆盖 4,999 / 5,000 字符边界与附件元数据。
- IPC 校验测试覆盖 Provider、数量与单附件 10 MiB 上限。
- Controller / Adapter 测试覆盖附件-only 发送、临时文件生命周期、mention 协议和持久化红线。
- Renderer 合同测试覆盖 paste handler、附件卡、可发送条件和 Composer 裁剪布局。
- App 全量测试、production build、真实 Electron 粘贴与截图、`git diff --check`。
