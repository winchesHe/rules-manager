# Chat · Codex / Paseo 布局真实实现

## Goal

将已确认的 `docs/prototypes/chat-codex-paseo-layout.html` 落到真实 Electron Renderer。
最终真实 App 的 Chat 布局必须与基线截图同构，同时保留并可操作现有 Chat、Rules Run、
Session Context 与主题能力；不能用静态假数据或仅视觉相似替代真实功能。

视觉基线：

- 默认态：`docs/prototypes/chat-layout-v2-preview.png`
- Session Context 收起态：`docs/prototypes/chat-layout-v2-collapsed-preview.png`
- Chat 历史收起态：`docs/prototypes/chat-layout-v2-focus-preview.png`

## 完整改动范围

- App Shell：保留 14rem 产品导航和主题切换，Chat 工作区去掉页面 padding 与外层 Card；移除
  “Workspace”产品概念。
- Chat Header：独立显示历史按钮、当前标题与对话管理；Session Context 关闭时显示恢复入口。
- Chat 历史：将现有 16rem/4rem Thread Rail 改为桌面默认展开的 18rem 可收起 Pane，保留 New Chat、
  Active/Archived、选择、重命名、归档、恢复、删除和 resume-failed 续开。
- Conversation：正文与 Composer 共享 820px 阅读线；短对话靠近底部；用户气泡、Assistant 正文、
  Activity timeline、复制与耗时对齐原型。
- Composer：输入与运行控件保持单 Surface；保留 Provider/model/effort/fast/Skills、发送/停止/队列、
  Full access 与 Provider 权威 Context Window；增加 Session Context 快捷入口与数量。
- Session Context：22rem 可收起 Pane，保留项目/日期查询、分页虚拟列表、选择/移除、来源失效和隐私说明；
  重排为已选 → 筛选 → 可选列表。桌面收起偏好本地持久化，窄屏使用覆盖式 Drawer。
- 响应式与可访问性：Drawer/Pane 支持遮罩、Escape、`inert`、焦点可见与 reduced motion，页面无横向滚动。
- 文档与测试：更新过期的常驻三栏、16rem Rail 和 60rem 阅读线契约，并同步 `DESIGN.md`、专项 spec
  与 `memory/process.md`。

## 不改变的业务边界

- 不修改 ChatStore 文件格式、Native Session 绑定、Provider adapter、IPC 协议、Rules Generation、
  Session Context 注入协议和隐私红线。
- 不删除 Fast Mode、Skills、Thread 生命周期、Rules Artifact、重新生成、停止、队列或 Tool 原文按需读取。
- HTML 中没有直接展示的 Fast Mode / Skills 收入 Composer 的次级配置入口，不能因视觉对齐而功能倒退。

## 验收标准

1. 1728×979 真实 Electron 默认态与 HTML 基线同构：14rem 全局导航、48px Chat Header、
   弹性 Conversation、22rem Session Context、820px Composer，无常驻 Thread Rail 和外层 Card。
2. 桌面进入 Chat 时默认展开 18rem 历史栏；独立图标可收起/恢复并重排 Conversation，所有 Thread 生命周期操作可用。
3. Session Context 可从 Header 和 Composer 打开；收起后中央列获得全部 22rem，重启后恢复桌面偏好。
4. 发送、流式消息、停止/队列、Provider/model/effort/fast/Skills、Tool 展开、Context 选择和 Rules 操作无回归。
5. 1279px 及以下使用覆盖式历史/Context Drawer；1024×768 无页面级横向滚动。
6. 主题切换在新版布局有效；中文和英文界面不存在缺失 key。
7. 定向布局/交互测试、App/Core 全量测试、App/Core production build 与 `git diff --check` 全部通过。
8. 输出真实 App 的默认、Context 收起、历史收起三张截图，并与 HTML 三张基线逐项对照。

## 观察点与验证方式

- 先更新结构契约测试，让旧实现因常驻 Rail、外层 Card、60rem 阅读线和缺少 Context 持久化明确失败。
- 每完成一个布局区块运行 App 定向测试；完成交互后用真实 IPC 数据 smoke，而不是只加载静态组件。
- 最后以 1728×979、1440×900、1024×768 三档启动 Electron，检查滚动所有权、遮罩、展开/收起、主题与视觉对齐。
- 最终执行两端全量测试和 production build，并把截图、尺寸与功能核对结果写入过程记录。

## 第二轮：默认历史栏与控件归属修正

最新版 HTML 将上一轮覆盖式历史 Drawer 改为 Chat 内部的 18rem 可收起历史栏，桌面进入 Chat
时默认展开且不遮罩 Conversation；1279px 及以下才降级为覆盖式 Drawer。Header 的历史按钮与
当前标题分离，Session Context 展开时在右栏自身 Header 内收起，关闭后主 Header 才显示恢复入口。

本轮观察点与验证方式：

- 1728×979 默认结构必须为 `224px 产品导航 + 288px 历史栏 + 864px Conversation + 352px Context`，
  历史栏不产生 backdrop；收起历史后 Conversation 增加 288px。
- 当前标题不再承担历史触发；独立历史图标、右栏“收起”和关闭后的“上下文 N”按钮均可由
  Computer Use 点击并观察状态变化。
- Composer 内容宽 820px；`+`、Context、Provider、Model、Effort、运行操作组与发送按钮均为
  32px 高并共享垂直基线。
- 1279px 及以下历史栏与 Context 使用遮罩式 Drawer；桌面与窄屏都不得产生页面级横向溢出。
- 先更新布局契约使旧覆盖式默认结构失败，再实现并执行 App/Core 全量测试、两端构建；最终必须
  使用 Computer Use 操作真实 Electron App 并保存默认、历史收起、Context 收起三张截图。

## 第三轮：历史操作与 Session 可读性修正

按真实 App 标注图继续修正信息密度和可操作性，完整范围与验收标准如下：

- History Pane 顶部 New Chat 与当前/归档切换改为一致的暗色 Surface 层级，不再出现突兀的白色
  Primary pill；历史条目显示更新时间。
- Native Chat 历史条目支持右键菜单，提供重命名、置顶/取消置顶、归档/恢复；置顶状态写入本地
  ChatStore 并在当前/归档列表内优先排序。旧 Rules Generation 记录保持只读兼容。
- Session Context Item 增加可读名称。OpenCode 从其权威 SQLite `session.title` 按需读取；其余来源
  使用项目名与 Agent 组成稳定回退名称。主行不再展示长 Session ID，ID 仅保留在 title/辅助说明中。
- Composer 左侧控件统一 8px 间距；Context Window meter 使用真实 Tooltip 展示 `used / max` 与百分比，
  同时保留可访问名称和 Provider 权威值约束。
- 自动化覆盖 ChatStore 置顶持久化与排序、IPC/Controller 路径、OpenCode 名称解析、Renderer 结构契约；
  最终运行 App/Core 全量测试与 production build，并用 Computer Use 在真实 Electron 中验证右键菜单、
  可读 Session 名称、历史时间、Tooltip 和整体视觉间距。

## 第四轮：History 顶部像素级对齐

以 `docs/prototypes/chat-codex-paseo-layout.html` 的 `.drawer-head`、`.drawer-title-row`、
`.new-chat-button`、`.drawer-tabs` 与 `.drawer-tab` 为唯一基准，修正真实 App 中 HeroUI 默认尺寸和
额外容器样式造成的偏差。

本轮验收标准与验证方式：

- History Pane 使用 Pane 背景；顶部区域为 12px padding、10px 行间距和 soft border。
- 标题为 12px / 650，关闭按钮固定 30×30px、8px 圆角；图标固定 14×14px。
- 新建对话按钮固定 34px 高、9px 圆角、7px 图文间距、11px / 620，并使用 Surface 背景。
- Tab 容器只保留两列和 4px 间距，不得附加背景、padding 或圆角；Tab 固定 28px 高、7px 圆角、
  10px 字号，激活态使用 Surface Raised。
- 先新增 Renderer 源码契约并确认旧实现失败，再实现主题 token 和精确类名；随后运行 App 全量测试、
  production build 与 `git diff --check`，最后通过真实 Electron 截图逐项复核上述尺寸与层级。

## 第五轮：Session Context 剩余空间利用

右栏 Header、筛选条件和底部隐私说明保持不变；Session Context 内容改为 `auto + minmax(0, 1fr)`
纵向布局，可选 Session 区域占满全部剩余高度。虚拟列表不再使用固定 290px viewport，而由
`ResizeObserver` 读取实际容器高度并据此计算可见范围。

本轮验收标准与验证方式：

- 1728×979 下 Session 列表从筛选区下方连续延伸到隐私说明上方，不再在“加载更多”后留下大片空白。
- 列表内部独立滚动，“加载更多”位于列表区域底部；隐私说明继续固定在右栏底部。
- 1279px 以下覆盖式 Context Drawer 继续满足 `min-height: 0`，不产生页面级溢出。
- 新增虚拟窗口纯函数测试，覆盖 viewport 变高时渲染行数同步增加；布局契约禁止恢复固定 290px 高度。
- 运行 App/Core 全量测试、两端 production build 和 `git diff --check`，最后在真实 production
  Electron 中测量列表区域并保存右栏截图。

## 第六轮：当前筛选结果全选

在“可选 Session / 数量”标题行增加全选切换按钮。按钮仅作用于当前已经加载的筛选结果：部分选中时
合并选择全部当前项，全部选中时取消当前项；其他项目或日期筛选下已选的 Session 必须保留。

本轮验收标准与验证方式：

- 可选列表非空时显示“全选”；当前加载结果全部选中后显示“取消全选”。
- 全选使用 `agent + id` 去重，不重复添加已选项；取消全选只移除当前结果，保留筛选外选择。
- 单项选择、已选择区移除、清空、分页加载和 Thread 持久化路径保持不变。
- 新增纯函数测试覆盖跨筛选保留和双向切换；更新中英文文案与布局契约，并在真实 App 中操作验证。

## 第七轮：筛选语义与已选区域稳定

Session Context 顶部区继续保持“已选择 → 筛选 → 可选 Session”的信息层级，但将已选择区改为固定
高度的独立区域，内部滚动；0 条和多条选中时，筛选区与可选列表的位置不得跳动。筛选区增加明确的
“筛选”小标题，说明项目、日期和快捷日期按钮属于同一组筛选条件。

本轮验收标准与验证方式：

- 已选择区始终渲染并固定为 11rem 高；空状态展示说明，非空状态列表在区域内部滚动。
- 筛选区增加小标题，中英文 key 完整；现有项目、日期、最近 7/30 天与清除行为不变。
- 自动化布局契约确认已选择区不再条件挂载，并在真实 App 中比较 0 条与全选后的筛选区 top 值。

## 第八轮：移除右栏底部说明

删除 Session Context 右栏底部的隐私说明区，让 Picker 直接占满 Header 下方的全部剩余高度；已选择、
筛选、可选 Session、全选与加载更多行为不变。

本轮验收标准与验证方式：

- Context aside 从三行 Grid 改为 Header + 内容两行，不再为底部说明预留高度。
- 中英文隐私说明 key 一并移除，避免保留无引用文案。
- 真实 App 验证说明消失，且可选 Session 列表底部扩展到右栏底部。

## 第九轮：Context Window hover 可用性

修复 Composer Context Window 圆形指示器只有 Tooltip 内容、没有有效 HeroUI Trigger 的问题。使用
显式 `Tooltip.Trigger` 承接 hover/focus 事件，并扩大命中区，Tooltip 立即展示具体 token 用量。

本轮验收标准与验证方式：

- 指示器保留原有 16px 圆形进度视觉，外层提供 24px hover/focus 命中区。
- hover 与键盘 focus 均能展示 `used / max (percent)`；无用量时展示不可用文案。
- 自动化布局契约要求显式 Trigger；真实 Electron hover 后确认 Tooltip 挂载并截图。
