# Plan 10 · 页面布局系统

## 范围与验收标准

- `DESIGN.md` 定义 collection / dashboard / task / workspace 四种页面原型。
- 页面宽度只能选择 narrow / wide / fluid，辅助栏只能选择 sm / md / lg。
- 建立 PageShell、SupportingPaneLayout、MetricStrip、PageSection 页面级 Primitives。
- Rules 总览迁为 dashboard + wide + md pane。
- Generate 迁为 task + wide + lg pane。
- 不修改业务状态、IPC、i18n 文案、主题、依赖，也不迁移其他页面。

## Step 1 · 固化页面决策

只更新 DESIGN 的原型决策表、宽度、主辅栏、密度、Surface 和滚动规则。

- 观察点：设计新页面时可以只回答“原型、宽度、Pane、滚动归属”四个问题。
- 验证方式：DESIGN 的每种原型均包含适用/禁用、区域顺序、宽度、滚动、响应式、
  主操作和 Do/Don’t。

## Step 2 · 建立最小 Primitives

只实现页面级结构，不抽象业务区块内部的 Stack / Grid。

- 观察点：Primitive 的 DOM landmark、data attribute、宽度和 Pane 语义可从真实渲染
  HTML 中观察。
- 验证方式：`page-layout.test.ts` 使用 `react-dom/server` 渲染并断言四个组件；
  测试不依赖源码字符串或 mock。

## Step 3 · 迁移 Generate 样板

只把 Generate 的根层宽度与双栏交给 PageShell / SupportingPaneLayout。

- 观察点：视觉与交互保持不变，布局声明变为 task + wide + lg pane。
- 验证方式：布局契约检查真实 import / JSX 使用；App production build 通过。

## Step 4 · 迁移 Rules Dashboard 样板

保持现有信息架构，只把 Header、KPI、主待办、右侧状态和项目入口纳入统一 Shell。

- 观察点：1920px 下内容不超过 1296px，Header / KPI / 正文共享边界；主待办明显
  宽于辅助栏，辅助栏在窄容器下位于主区之后。
- 验证方式：组件渲染测试 + 布局契约；临时移除 PageShell 时测试变红，恢复后全绿。

## Step 5 · 真实窗口与完整回归

- 观察点：1024×768、1440×900、1920×1080 均无横向溢出，宽屏 Pane 在右，
  窄屏 Pane 下沉；每页只有一个 Primary Action。
- 验证方式：保存两页 1920 截图；Core / App 全量测试、两个 production build 与
  `git diff --check` 全通过。

## Step 6 · 收敛 Rules Dashboard 信息层级

移除脱离任务上下文的顶层 KPI 带，把待审核与已接受数量并入审核主区；将 Agent 健康、
最近生成和项目入口合并为一个辅助状态面板。

- 观察点：首屏唯一主视觉是审核队列，右栏形成完整的支持面板，不再有横跨页面的孤立
  项目入口。
- 验证方式：布局契约断言主区摘要与统一状态面板存在、Dashboard 不再渲染 MetricStrip；
  三档真实窗口继续满足 Pane 折叠与无横向溢出。
