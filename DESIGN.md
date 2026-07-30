# Memory Manager · 设计规范

基于 HeroUI v3 + Tailwind CSS v4 的主题系统。所有 UI 组件优先使用 HeroUI 组件，样式通过 HeroUI CSS 变量（design tokens）控制，避免硬编码颜色值。

## 主题模式

默认 **dark 模式**（侧边栏 + 工作区统一暗色调），支持 light 模式切换。

## 色彩 Token

基于 HeroUI v3 的 CSS 变量体系（`--heroui-*`），自定义扩展：

| 语义 | CSS 变量 | 值（dark） | 值（light） | 用途 |
|---|---|---|---|---|
| 背景-主区域 | `--color-background` | `hsl(220 14% 10%)` | `hsl(220 18% 96%)` | workspace 主背景 |
| 背景-侧边栏 | `--color-sidebar` | `hsl(220 14% 8%)` | `hsl(0 0% 100%)` | 侧边栏背景 |
| 背景-卡片 | `--color-surface` | `hsl(220 12% 13%)` | `hsl(0 0% 100%)` | Card / Panel 背景 |
| 背景-悬浮 | `--color-surface-hover` | `hsl(220 12% 16%)` | `hsl(220 16% 94%)` | 导航 hover / active |
| 前景-主文字 | `--color-foreground` | `hsl(220 10% 94%)` | `hsl(220 18% 16%)` | 标题、正文 |
| 前景-次文字 | `--color-muted` | `hsl(220 10% 55%)` | `hsl(220 10% 44%)` | 描述、标签 |
| 强调色 | `--color-primary` | `hsl(156 50% 45%)` | `hsl(156 55% 34%)` | 品牌绿，active icon |
| 强调色-柔 | `--color-primary-soft` | `hsl(156 40% 20%)` | `hsl(156 45% 92%)` | accent card 背景 |
| 边框 | `--color-border` | `hsl(220 12% 18%)` | `hsl(220 14% 88%)` | 分隔线、卡片边框 |
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
| 组件间垂直间距 | `space-y-4` / `space-y-6` |

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

- 侧边栏固定宽 `w-56`（224px），暗色背景
- 工作区 `flex-1`，同系暗色稍亮背景
- 侧边栏 settings 贴底（`mt-auto`）

## 首页信息架构

三个主界面统一使用渐进展示，禁止把“列表定位”和“对象操作”同时塞进左右分栏：

- **Scan**：默认只展示最近扫描结果；“新建扫描”进入独立 Agent 配置页。
- **Projects**：默认只展示可搜索、可筛选的项目列表；选择项目后进入独立详情，详情内切换 Sessions / Rules。
- **Chat**：统一承载 Agent Run 的流式过程与可恢复正文；Thread Rail 负责定位，中央对话负责 Request / Assistant / Artifact，右侧 Context 只展示当前 Run 的范围与 Evidence。
- **Rules**：默认只展示候选规则队列；生成范围、单条审核、产物输出分别进入独立页面。
- 返回按钮恢复上一层列表；主导航再次点击时回到该模块默认页。
- 大数据列表采用“数据层限定查询 + renderer 虚拟窗口”，默认只渲染可视区域附近的行。
- 同一页面只保留一个主操作按钮；次级操作使用 ghost，状态计数使用 Chip。

### Chat 第一版

- 主导航顺序为 Scan / Projects / Chat / Rules。
- Rules 负责选择 Evidence scope、审核和发布；生成开始后创建 Chat Thread 并切换到 Chat。
- Chat 使用 Thread Rail + Conversation + Context 三段布局；窄窗口时 Context 下沉，不产生页面级横向滚动。
- 用户请求使用右侧轻量气泡，Assistant 使用无气泡正文，Candidate 使用结构化 Artifact。
- 第一版不提供 Composer、通用 New chat、连续追问或 Session Summary。
- Chat 可见正文使用 FS-first 本地持久化；隐藏 Prompt、Session 原文、tool 参数和 tool output 不进入 Chat 文件。

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
  --color-sidebar: hsl(220 14% 8%);
  --color-surface: hsl(220 12% 13%);
  --color-surface-hover: hsl(220 12% 16%);
  --color-muted: hsl(220 10% 55%);
  --color-border: hsl(220 12% 18%);
  --color-primary: hsl(156 50% 45%);
  --color-primary-soft: hsl(156 40% 20%);
}
```

## 规范引用

本文件作为 APP UI 实现的权威设计源。所有颜色、间距、组件选型以此为准。
