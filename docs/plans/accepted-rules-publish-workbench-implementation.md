# 已接受规则发布工作台实现

## 范围

- 将 `OutputRulesPage` 的中间内容按 `docs/prototypes/rules-publish-task-workbench.html` 重构。
- 保留现有 accepted rules、Agent instructions、项目导出、Claude Memory、Codex Memory 的 IPC 与并发校验。
- 不修改 Core 发布协议、规则存储格式、主导航或其他 Rules 子页面。

## 设计对齐

- 页面采用 `task + wide + compact`，顶部为项目规则、Memory、全局规则三段切换；两个项目上下文相邻，全局范围置后。
- 主体为单一满高工作台：项目标题与导出、规则选择区、当前目标配置区、底部摘要与唯一主操作。
- Agent 目标只在规则发布上下文展示；Memory 内 Claude/Codex 互斥展示，避免并列双主操作。
- 沿用 HeroUI、Tailwind v4 和项目主题 token，不引入依赖或新视觉系统。

## 验收标准

1. 实际 App 的信息结构、主要比例、间距、满高卡片和底部操作栏与 HTML 原型基本一致。
2. 三个 Tab 均可达；Memory 内 Claude/Codex 切换后只存在当前目标对应的主按钮。
3. 项目选择、规则勾选、Agent 多选、目标选择、导出与所有真实发布 IPC 行为不回归。
4. 加载、空态、错误和成功反馈保留；窄屏转为单列且无页面级横向溢出。
5. App 定向测试、全量测试和 production build 通过；typecheck 输出完成基线审计，确认本次区域没有新增错误。
6. 在相同窗口尺寸下截图实际 App 与 HTML 原型，对比顶部 Tab、工作台边界、主辅栏和底部操作栏；修正明显偏差。

## 观察点与验证方式

- 布局契约：源码测试断言三个 tab、单一工作台、单一主操作标记和满高结构。
- 状态联动：真实 App 手工切换 tab、Agent、Claude/Codex 与目标，观察禁用态和摘要。
- 视觉对比：固定窗口尺寸分别截图原型与 App，检查同一构图锚点。
- 回归：`npm test -w @memory-manager/app`、`npm run typecheck -w @memory-manager/app`、`npm run build -w @memory-manager/app`。
