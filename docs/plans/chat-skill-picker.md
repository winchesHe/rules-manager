# Chat Composer Skill Picker

## 目标

将 Chat Composer 中不适合大量 Skill 的普通单选下拉替换为紧凑、可搜索的多选 Picker，保持 Claude / Codex
原生 `/skill-name` 调用语义，同时让消息正文与 Skill 附件在编辑阶段分离。

## 观察点

- Picker 固定在 Composer 附近，不超过可用视口，不遮挡整段对话。
- 搜索框打开后自动聚焦，可按名称和描述筛选；方向键、Enter 与 Escape 可完成选择和关闭；输入独立
  `/` 可快捷唤起，URL 和文件路径中的斜杠不触发。
- 已选 Skill 以 chip 展示并可直接移除；Picker 保持打开以连续多选。
- 最近使用只保存在本机 UI 偏好中；发送后清空本轮选择，但记录最近使用。
- 发给原生 Agent 的最终消息仍为 `/skill-a /skill-b 用户正文`，不改 Native Chat IPC 协议。
- 主进程只读取 `SKILL.md` frontmatter 的描述和来源，不向 Renderer 暴露技能正文或文件路径。

## 验证方式

- 单元测试覆盖 Skill 合并、frontmatter 描述提取、来源优先级、搜索排序、消息组装和最近使用。
- Renderer 布局契约确认旧 `Select` 被移除，并保留固定尺寸、搜索、多选、chip 与键盘行为。
- App 定向测试、全量测试与 production build。
- 在 production Electron 中验证打开、搜索、连续选择、chip 移除、发送后清空及窄窗口边界。
