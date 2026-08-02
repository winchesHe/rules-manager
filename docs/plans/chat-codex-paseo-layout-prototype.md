# Chat · Codex / Paseo 布局原型

## 范围与验收标准

本轮只新增独立 HTML 视觉原型，不修改 Renderer、Native Chat、Session Context 或持久化逻辑。
原型用于确认后续 Chat View 的最终布局方向。

验收标准：

- 1728×979 视口下采用贴边桌面工作台：产品级左侧栏、弹性 Conversation、可收起的
  22rem Session Context 右栏，不出现页面外层 Card 和四区嵌套。
- 左栏默认 14rem，只承载 Memory Manager 产品导航；Chat 历史通过页面内 Drawer 按需打开。
  当前 Chat 使用中性 Surface 选中态，品牌绿只表达产品标识、状态和安全语义。
- Conversation 与 Composer 共享 820px 阅读线；用户消息右对齐，Assistant 和 Tool Activity
  使用无头像、无大卡片的紧凑时间线。
- 右栏通过 Header 按钮在 22rem 与 0 之间切换；收起后 Conversation 自动扩展，按钮保留已选
  Session 数量。窄屏使用覆盖式面板。
- 原型包含可操作的历史 Drawer、Chat 切换、Active / Archived 切换、Session 选择与右栏收起/展开，便于检查
  信息密度和状态反馈。

## 观察点与验证方式

1. **桌面骨架**：确认永久区域最多三块，左栏与右栏均贴边，中央区没有额外圆角容器。
   - 验证：以 1728×979 渲染截图，与 Codex P1 的栏宽、顶部基线、Composer 位置和留白对照。
2. **对话密度**：正文在 820px 对齐线内，Tool Activity 折叠态不超过紧凑单行高度。
   - 验证：截图检查长正文、用户气泡、Activity、Assistant footer 和 Composer 的纵向节奏。
3. **右栏行为**：展开时为固定辅助 Pane，收起时不残留空列，已选数量仍可见。
   - 验证：执行原型内置交互并分别截取展开、收起状态。
4. **静态质量**：HTML 不依赖远程资源，键盘焦点可见，主要按钮具备 aria-label。
   - 验证：定向文本检查、HTML 加载 smoke、`git diff --check`。

## Follow-up：非 Chat 主应用左栏修正

Memory Manager 不是 Chat-first 产品，也没有用户登录和 Workspace 管理概念，因此不继续照搬
Codex 将项目和 Chat 历史常驻在全局左栏的结构。

调整后的验收标准：

- 全局左栏只承载 Memory Manager 品牌、Scan / Projects / Chat / Rules 与 Settings；不展示用户头像、
  Pinned、Workspace 或项目分组 Chat。
- Chat 历史属于 Chat 页面局部能力，通过 Header 中的入口打开临时 Drawer；默认不占用永久布局宽度，
  关闭后页面仍只有全局左栏、Conversation、可选 Session Context 三块。
- Chat Drawer 包含 New Chat、Active / Archived 和扁平历史列表，不伪造 Workspace 归属。
- 右侧 Session Context 的收起展开、820px 阅读线和紧凑 Activity 保持不变。
- 重新以 1728×979 渲染展开态和右栏收起态，观察全局导航是否保持产品级层次、Chat Drawer 是否按需出现。
