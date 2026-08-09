# Agent Dashboard · 设计规范

基于 HeroUI v3 + Tailwind CSS v4 的主题系统。所有 UI 组件优先使用 HeroUI 组件，样式通过 HeroUI CSS 变量（design tokens）控制，避免硬编码颜色值。

## 主题模式

默认 **dark 模式**，支持 light 模式切换。dark 使用 Codex 风格深炭灰与白色前景，light 使用白蓝配色；
用户选择保存在本机，重启后恢复上次主题。

## 色彩 Token

基于 HeroUI v3 的 CSS 变量体系（`--heroui-*`），自定义扩展：

| 语义 | CSS 变量 | 值（dark） | 值（light） | 用途 |
|---|---|---|---|---|
| 背景-主区域 | `--color-background` | `hsl(0 0% 12%)` | `hsl(214 40% 97%)` | workspace 主背景 |
| 背景-侧边栏 | `--color-sidebar` | `hsl(0 0% 9%)` | `hsl(0 0% 100%)` | 侧边栏背景 |
| 背景-卡片 | `--color-surface` | `hsl(0 0% 15%)` | `hsl(0 0% 100%)` | Card / Panel 背景 |
| 背景-悬浮 | `--color-surface-hover` | `hsl(0 0% 19%)` | `hsl(214 100% 96%)` | 导航 hover / active |
| 前景-主文字 | `--color-foreground` | `hsl(0 0% 100%)` | `hsl(222 47% 11%)` | 标题、正文 |
| 前景-次文字 | `--color-muted` | `hsl(0 0% 65%)` | `hsl(215 16% 47%)` | 描述、标签 |
| 强调色 | `--color-primary` | `hsl(0 0% 100%)` | `hsl(217 91% 60%)` | 主操作、active icon |
| 强调色-柔 | `--color-primary-soft` | `hsl(0 0% 20%)` | `hsl(214 100% 93%)` | accent card 背景 |
| 边框 | `--color-border` | `hsl(0 0% 22%)` | `hsl(214 32% 91%)` | 分隔线、卡片边框 |
| 危险 | `--color-danger` | `hsl(0 60% 50%)` | `hsl(0 65% 48%)` | 错误状态 |
| 成功 | `--color-success` | `hsl(156 60% 40%)` | `hsl(156 55% 34%)` | 在线状态点 |

## 圆角

沿用 HeroUI 默认 radius token：

| 场景 | 值 |
|---|---|
| 卡片/面板 | `--heroui-radius-lg`（12px） |
| 按钮/输入框 | `--heroui-radius-md`（8px） |
| 头像/徽标 | `--heroui-radius-full` |
| 导航项 | `--heroui-radius-sm`（6px） |

## 间距

| 场景 | Tailwind class |
|---|---|
| 页面内边距 | `p-8` ~ `p-12`（响应式） |
| 卡片网格间距 | `gap-4` |
| 侧边栏内边距 | `px-4 py-6` |
| 普通组件内部垂直间距 | `space-y-4` / `space-y-6` |
| PageShell 一级区块间距 | `grid gap-6` / `grid gap-7` |

## 布局（方案 A）

```
┌──────────────────────────────────────────┐
│ sidebar (w-56)  │ workspace (flex-1)     │
│ ┌─────────────┐ │ ┌──────────────────┐   │
│ │ brand       │ │ │ page-header      │   │
│ │ nav items   │ │ │ summary cards    │   │
│ │             │ │ │ content panel    │   │
│ │ settings ↓  │ │ └──────────────────┘   │
│ └─────────────┘ │                        │
└──────────────────────────────────────────┘
```

- 侧边栏固定宽约 `11.125rem`（178px），按 Workspace / Knowledge 分组
- 侧栏可通过右侧主界面顶部的按钮收起为 `3.5rem` 图标栏；按钮完整位于内容区，不跨压侧栏边框；
  收起后保留主导航、知识库父级、Settings 与主题按钮，
  知识库叶子暂时隐藏并在点击父级图标后恢复展开侧栏
- Workspace 固定展示 Scan / Projects / Chat；Knowledge 直接展示「规则管理」「Agent 上下文」两个
  默认展开的可折叠父级，四个叶子入口通过细竖线表达从属关系
- 只有当前知识库叶子显示选中底色；父级只负责展开/收起，不使用选中胶囊
- 工作区 `flex-1`，同系暗色稍亮背景
- 侧边栏 Settings 与主题快捷切换贴底（`mt-auto`）；Settings 中同时提供完整主题选择

## 页面布局系统

全局侧边栏属于 App Shell；页面 Grid 只管理工作区内的内容。新增页面必须先选择一种
页面原型和一个宽度档，再组合业务组件，禁止从任意 `max-w-*`、裸 `rem` 辅助栏或
临时 breakpoint 开始设计。

### 宽度档

| 档位 | 最大宽度 | 适用 | 禁用 |
|---|---:|---|---|
| `narrow` | 54rem / 864px | 设置、表单、阅读型详情 | Dashboard、数据表格 |
| `wide` | 81rem / 1296px | 默认产品页、Dashboard、Collection、Task | 无理由的横向画布 |
| `fluid` | 工作区可用宽度 | Chat、流式 Run、大型横向数据工作区 | 普通 Dashboard、表单、阅读页 |

- `wide` 是普通页面默认值；只有“窗口更宽会展示更多有用信息”时才允许 `fluid`。
- Page Header、指标、正文和辅助栏必须共享同一个 `PageShell` 左右边界。
- 全出血背景可以突破内容边界，但其中的内容仍须回到同一 Grid。
- 页面横向 padding 由 `PageShell` 统一提供；View 不重复计算 App 侧边栏后的宽度。

### 页面原型决策表

| 原型 | 适用 / 禁用 | 区域顺序 | 宽度与滚动 | 响应式与主操作 |
|---|---|---|---|---|
| `collection` | Scan、Projects、规则列表；不用于对象详情 | Header → toolbar → 单一 collection | `wide`；页面滚动，长列表自身可虚拟滚动 | 窄容器精简列；主操作在 Header，最多一个 |
| `dashboard` | 状态概览与待办入口；不用于高密度全宽报表 | Header → ≤4 KPI → 唯一主工作区 + 辅助栏 → ≤1 个低频入口 | `wide`；页面滚动；辅助栏 `md` | 辅助栏下沉到主区之后；主操作在 Header |
| `task` | Generate、Review、Settings、任务型详情；不用于多对象浏览 | Header → 任务主体 + 可选配置栏 → 就近提交 | `narrow` 或 `wide`；页面滚动；配置栏 `lg` | 配置栏下沉且保持 DOM 后置；提交靠近配置摘要 |
| `workspace` | Chat、流式 Generation Run；不用于普通内容页 | 持久导航 → 主工作区 → 上下文 Pane | `fluid`；固定 viewport，各 Pane 独立滚动 | 窄屏拆页、隐藏或转 Sheet，不能机械堆叠长导航 |

Do：先确定用户当前唯一主任务，再选择能表达主次关系的原型。  
Don’t：为了填满屏幕把普通页面拉成 `fluid`，或在同一页并列多个同权主工作区。

### 主辅栏语义

| 档位 | 宽度 | 用途 |
|---|---:|---|
| `sm` | 18rem | 简短元数据、运行上下文 |
| `md` | 20rem | Dashboard 健康状态、最近活动 |
| `lg` | 22rem | 表单配置、需要完整控件的运行参数 |

- 主栏固定为 `minmax(0, 1fr)`；辅助栏只承载支持主任务的信息或配置。
- 主辅栏默认 gap 为 2rem；页面只能选择语义档，禁止写裸 `18rem / 20rem / 22rem`。
- 折叠由 `SupportingPaneLayout` 统一控制；DOM 中主区在前、辅助栏在后。
- 同权内容才允许等宽分栏；列表—详情是 Workspace，不套固定窄辅助栏。

### 密度、Surface 与滚动

- 页面密度只有 `comfortable` 和 `compact` 两档。Task 默认 comfortable；Dashboard
  的 KPI 与状态栏可以 compact。同类区块必须保持同一档，禁止单块临时缩 padding。
- PageShell 一级区块必须由父级 `grid gap` 提供间距，禁止用可被子组件 margin 覆盖的
  `space-y`；PageHeader 等子组件不得负责与下一个一级区块之间的距离。
- Dashboard 一级区块优先使用 flat section + divider；Card 只表达可独立操作或明确
  边界，禁止用大 Card 填补留白，也禁止 Card 套 Card。
- Dashboard 的指标必须服务于当前主任务。待审核数、已接受数等任务指标应进入主工作区
  的摘要，不应为了凑齐四项单独占据整行；Agent 健康、最近运行、项目入口等支持信息应
  合并为一个辅助状态面板，避免多个孤立小区块。
- 普通页面的滚动归 `PageShell` 外层页面；Workspace 才能接管 viewport，并明确每个
  Pane 的滚动归属。
- 页面最多一个 Primary Action。次级导航或管理入口使用 ghost，提交动作放在其结果
  或配置上下文附近。

### 页面级 Primitives

- `PageShell`：唯一拥有页面原型、宽度、密度、页面滚动和顶层对齐线。
- `PageHeader`：唯一 H1、单行描述和最多一个 Primary Action。
- `SupportingPaneLayout`：唯一拥有主辅 Grid、语义栏宽和折叠顺序。
- `MetricStrip`：最多 4 个 KPI，统一分隔与两列降级。
- `PageSection`：统一 section title、description 与一个次级 action。

Primitives 只约束页面级构图，不替代 Tailwind 的组件内部布局。确实需要第五种原型时，
必须同时补充本节决策表、对应 Primitive 行为和布局契约测试。

参考：

- [Atlassian Grid](https://atlassian.design/foundations/grid-beta/applying-grid/)
- [Primer Layout](https://primer.style/product/getting-started/foundations/layout/)
- [Primer PageLayout](https://primer.style/product/components/page-layout/)
- [Material canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview)

## 首页信息架构

三个主界面统一使用渐进展示，禁止把“列表定位”和“对象操作”同时塞进左右分栏：

- **Scan**：默认只展示最近扫描结果；“新建扫描”进入独立 Agent 配置页。
- **Projects**：默认只展示可搜索、可筛选的项目列表；选择项目后进入独立详情，详情内切换 Sessions / Rules。
- **Chat**：统一承载 Agent Run 的流式过程与可恢复正文；产品导航保持 Scan / Projects / Chat / Rules，
  桌面端对话历史在 Chat 内默认展开并可独立收起，中央对话负责 Request / Assistant / Artifact，右侧 Session
  Context 负责选择当前 Chat 引用的历史 Session。
- Chat 终态操作与 Run 状态一致：成功且有候选时提供审核出口；失败、取消或中断时提供“重新生成”，复用原请求创建新 Run 并保留旧 Thread；运行态不提供重复生成。
- **Rules**：默认只展示候选规则队列；生成范围、单条审核、产物输出分别进入独立页面。
- Rules 候选队列支持当前可见范围内的多选和全选；批量接受/拒绝使用临近表格的选择
  工具栏，切换状态或生成批次必须清空选择，批量写入必须具备事务原子性。候选行从
  Checkbox 到置信度列均为选择热区，最右侧审核操作保持独立。
- Rules 单条审核中的 Evidence 应直接回答“来自哪个会话、哪段上下文”：按引用从源文件
  按需读取脱敏窗口，突出命中消息；技术 locator 仅用于定位，不作为面向用户的正文。
  会话原文、Prompt、工具参数和工具结果仍不得写入 DB 或 Chat 文件。
- 历史 locator 能定位到消息不等于该消息具备 Evidence 资格。AGENTS / CLAUDE 注入和
  平台上下文必须标为“已排除、不参与生成”，只有真实用户信号可以显示“Evidence 命中”。
- 返回按钮恢复上一层列表；主导航再次点击时回到该模块默认页。
- 大数据列表采用“数据层限定查询 + renderer 虚拟窗口”，默认只渲染可视区域附近的行。
- 同一页面只保留一个主操作按钮；次级操作使用 ghost，状态计数使用 Chip。

### Chat 第一版（历史实现）

- 主导航按 Workspace 的 Scan / Projects / Chat 与 Knowledge 的「规则管理 / Agent 上下文」组织；
  Rules 内部页面继续由四个知识库叶子入口承载。
- Rules 负责选择 Evidence scope、审核和发布；生成开始后创建 Chat Thread 并切换到 Chat。
- Chat 使用 Thread Rail + Conversation + Context 三段布局；窄窗口时 Context 下沉，不产生页面级横向滚动。
- 用户请求使用右侧轻量气泡，Assistant 使用无气泡正文，Candidate 使用结构化 Artifact。
- 第一版不提供 Composer、通用 New chat、连续追问或 Session Summary。
- Chat 可见正文使用 FS-first 本地持久化；隐藏 Prompt、Session 原文、tool 参数和 tool output 不进入 Chat 文件。

上述条目描述现有 Rules Generation 只读 Chat。通用 Chat 重构以
[Chat View 原生 Agent Session 重构规格](docs/specs/chat-view-native-sessions.md) 为准；旧 Thread
继续只读兼容，不再把“无 Composer”作为新 Chat 的限制。

### Chat 原生 Session 重构

- Chat 继续使用 `workspace + fluid`：14rem 产品导航是唯一常驻左栏，Chat 内部由 Conversation
  与可收起的 22rem Session Context 组成，不再常驻 Thread Rail，也不使用页面外层 Card。
- Chat Header 使用独立历史按钮控制 18rem 历史栏，当前标题不承担导航；桌面端历史栏默认展开并
  重排 Conversation，1279px 及以下才转为覆盖式 Drawer。Session Context 保持独立开关与收起入口。
- History 条目显示更新时间；Native Chat 支持右键重命名、置顶和归档，置顶项在当前/归档分组内优先。
- Conversation 与 Composer 共享 820px 阅读线；各滚动区独立，页面级容器不滚动。
- Conversation 底部固定 Composer。首次发送前是临时 Draft；发送后一个 Chat 永久绑定一个
  Claude 或 Codex Native Session，Provider 不可切换。
- 通用 Chat 操作、消息层级、Skill 插入、重命名和运行状态参考 Paseo；右侧 Session
  Context、Rules Run intent 和 Native 生命周期遵循专项规格。
- Tool 原始 input/output 可以在用户展开时从 Native Session 按需查看，但不进入 ChatStore；
  默认只保存和展示 Native Item 引用、安全摘要与有限预览。隐藏 Prompt 永不进入 Renderer。
- Context Window 只显示 Provider 权威值，缺失时显示不可用，不在应用侧估算。
- Session Context 主行优先显示来源提供的可读标题；OpenCode 使用 SQLite `session.title`，其他来源
  使用项目与 Agent 回退，原始 Session ID 仅作为辅助信息。
- Full access 是固定运行模式，必须在 Composer 附近常驻显示；页面不提供 Permission Mode 或
  working directory 控件。
- Fast Mode 与 Agent、Model、Effort 同属本轮运行配置，常驻 Composer 底栏并可直接切换，不放入
  Skill Picker 或二级菜单。
- Skill 作为“下一条消息附件”展示：Composer 使用固定尺寸、可搜索的多选 Picker，支持名称与描述搜索、
  最近使用、键盘选择和 chip 移除，输入独立 `/` 可快捷唤起；发送时再转换为原生 `/skill-name` 前缀，
  发送后清空本轮选择。

### Chat Agent Stream

- Chat 页面固定为 viewport 内可用高度，页面级容器不滚动；Conversation、Context 和历史栏分别
  拥有内部滚动区。
- Assistant 历史正文与运行中增量统一使用 React 流式 Markdown 渲染；标题、列表、链接、引用、
  行内代码和代码块按语义展示，用户消息保持纯文本，复制操作继续使用原始 Markdown。
- Agent 执行过程参照 Paseo P1，使用无卡片的紧凑 Activity timeline。
  Provider 事件统一映射为 Thinking / Read / Search / Shell / Tool，不直接渲染
  Provider 原始 payload。
- 同一 Assistant Turn 的正文片段、Thinking 与 Tool 必须按 Provider 首次发出事件的顺序组成统一
  timeline；Tool 的 running / completed 只更新原位置，不能将所有正文或 Tool 分组后重新排序。
- 新消息持久化上述 timeline，刷新前后顺序一致；缺少 timeline 的旧消息无法恢复已经丢失的中间顺序，
  统一回退为 Tool 在前、最终正文在后。
- Activity 摘要只允许单行、定长的可见上下文：文件路径、搜索词、命令摘要或
  tool 名称。tool output、原始 input 对象、隐藏 Prompt 和 Session 原文禁止进入
  Renderer 或 Chat 文件。
- 运行中显示 elapsed time；Conversation 仅在用户仍接近底部时自动跟随新事件，
  用户主动上滚后不得抢夺阅读位置。
- Project response 可以在 Main 中逐项目 checkpoint，但 Candidate Artifact 只有在
  Thread `completed` 后才一次性全部展示。取消、失败或中断不展示半成品 Rules。
- Conversation 不显示 Assistant 头像、Assistant 标题或重复状态 Chip；Request 之后
  直接进入 Activity timeline，减少无信息量的层级。
- Thinking 使用单行 Activity header；Provider 明确输出 thinking / reasoning 正文时，
  header 可点击展开，正文保留换行并限制长度。同一 Activity 的 running / completed
  更新必须合并，不能重复堆积 Thinking。
- Provider 不一定发生 tool call。Activity timeline 同时如实展示 Rules Generation
  pipeline 的 Collect / Analyze / Draft / Validate / Retry；不得为了丰富界面伪造
  Read / Search / Shell。

## 组件映射

| 场景 | HeroUI 组件 | 说明 |
|---|---|---|
| 侧边栏导航项 | `Button` variant="ghost" | 左对齐，带 icon slot |
| 扫描结果 | `Table` + `Chip` | 按 Project 汇总 new / updated / missing |
| 项目列表 | `Table` + 搜索 / 筛选 | 点击项目进入独立详情 |
| Session 列表 | 虚拟窗口 + 分隔行 | 固定行高，仅渲染可视行附近数据 |
| 规则候选列表 | `Table` + `Chip`（confidence） | 带 accept/reject action |
| 置信度标签 | `Chip` variant="flat" color={level} | high=success, medium=warning, low=default |
| Accept/Reject 按钮 | `Button` size="sm" | 绿/红色 |
| 加载态 | `Skeleton` / `Spinner` | 首屏加载 |
| 错误态 | `Alert` variant="flat" color="danger" | 替代手写 error-state |
| 空状态 | 自定义 empty 块 | 图标 + 文字居中 |
| 设置页 | `Modal` 或侧面 `Drawer` | 后续实现 |

## 字体

系统字体栈（HeroUI 默认）：

```css
font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
```

## 图标

统一使用 `lucide-react`，size 默认 `18`，颜色跟随 `currentColor`。

## Tailwind 自定义配置

在 `styles.css` 中通过 `@theme` 注册自定义 token：

```css
@import "tailwindcss";
@import "@heroui/react/styles";

@theme {
  --color-sidebar: hsl(var(--theme-sidebar));
  --color-surface: hsl(var(--theme-surface));
  --color-surface-hover: hsl(var(--theme-surface-hover));
  --color-muted: hsl(var(--theme-muted));
  --color-border: hsl(var(--theme-border));
  --color-primary: hsl(var(--theme-primary));
  --color-primary-soft: hsl(var(--theme-primary-soft));
}
```

## 规范引用

本文件作为 APP UI 实现的权威设计源。所有颜色、间距、组件选型以此为准。
