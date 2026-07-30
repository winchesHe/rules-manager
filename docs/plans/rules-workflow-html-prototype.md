# Rules 全流程 HTML 原型

## 改动范围

- 新增一份独立 HTML 原型，不修改当前 Electron Renderer。
- 覆盖 Generate、Agent Run、Review、Publish 四个完整布局。
- Agent Run 参考 Paseo Chat View 的 Turn、Activity、Candidate、运行 Footer 与底部跟随结构。

## 验收标准

1. HTML 可直接打开，不依赖构建步骤。
2. 顶部流水线导航和页面主操作可以切换四个布局。
3. Run 页面包含 Request、Assistant Markdown、可展开 Activity、Candidate、运行状态和 Evidence Drawer。
4. Review 页面支持选择 Candidate，并演示 Accept / Reject 后移动到下一条。
5. 窄窗口下不产生不可用的横向布局。

## 实现步骤

### 1. 搭出端到端最小骨架

- 改动：创建独立 HTML，建立 App Shell 和四个页面容器。
- 观察点：点击导航可以切换页面，当前阶段有明确选中态。
- 验证方式：浏览器逐页点击并检查页面标题。

### 2. 完成 Agent Run Chat

- 改动：实现 Paseo 风格消息层级、Activity、Candidate 和 Evidence Drawer。
- 观察点：Chat 是页面视觉中心，过程状态不再重复为左侧阶段时间线。
- 验证方式：展开 Activity/Candidate，打开并关闭 Evidence Drawer。

### 3. 完成 Review / Publish 交互

- 改动：实现候选主从审核与发布预览。
- 观察点：审核时不离开候选上下文，发布前能看见目标与规则分组。
- 验证方式：执行 Accept / Reject 并切换 Publish。

### 4. 视觉与静态契约验证

- 改动：补齐响应式、键盘焦点和语义标签。
- 观察点：桌面与窄窗口均可阅读和操作。
- 验证方式：静态契约脚本、HTML 解析和浏览器视觉检查。

## 完成记录

- ✅ 四个布局已通过流水线导航和页面主操作串联。
- ✅ Agent Run 已实现 Request、Assistant、Activity、Candidate、Turn Footer、项目队列与 Evidence Drawer。
- ✅ Review 已验证 Accept 后 Draft 从 12 变为 11，并自动移动到下一条。
- ✅ Publish 已验证规则分组、目标路径和安全说明。
- ✅ 1280px 与 700px 宽度均无页面级横向溢出。

## Round 2 · 完整运行状态演示

### 改动范围

- 在同一份 HTML 中补齐 Evidence collecting、Generating、Validating、Completed 四个 Run 状态。
- 增加原型专用状态切换与自动 Replay，不把演示控件误当生产功能。
- 不修改现有 Core / Worker / Renderer。

### 观察点

- Evidence 收集时 Chat 仍是唯一主叙事，项目 Rail、Activity 和底部状态同步变化。
- 收集完成后自然进入 Assistant 分析；Validate / Save 不重新引入阶段侧栏。
- Completed 状态明确收口到 Review drafts。

### 验证方式

- 手动切换四个状态，检查标题、项目状态、Chat 内容和 Footer 一致。
- Replay 后确认状态按 Evidence → Generate → Validate → Complete 推进。
- 浏览器检查完整流程与窄窗口无横向溢出。

### 完成记录

- ✅ Evidence 展示逐项目收集、19/28 Sessions、312 Excerpts 与隐私边界。
- ✅ Generating 展示 Assistant 分析、Activity 与结构化 Candidate。
- ✅ Validate & save 展示去重、校验和事务保存进度。
- ✅ Completed 展示运行摘要，并只在此状态出现 Review drafts。
- ✅ Replay 在 9.5 秒内自动走完四个状态；状态也可固定切换检查。
- ✅ Review 出口、1280px 与 700px 响应式布局验证通过。

## Round 3 · Evidence snapshot 语义修正

### 设计结论

- Run 只有一份 Evidence snapshot；它聚合多个 Project bundles，但不把 bundle 扁平为一个 Project。
- Evidence collecting 表达一次聚合快照构建，不表达逐 Project 任务队列。
- Project queue 只在 Agent 开始逐 bundle 生成时出现。

### 验收标准

- Evidence 状态隐藏左侧 Project queue，Chat 使用完整宽度。
- 收集卡只显示 Run-level Sessions / Project groups / Excerpts 聚合进度。
- Project 名称只作为 snapshot 中的 source groups，不带完成/等待状态。
- 删除 “Collecting <project> evidence” 等会产生逐项目收集暗示的文案。
- Generating / Validating / Completed 仍保留 Project queue。

### 完成记录

- ✅ Evidence 状态切换为单列 Chat，Project queue 完全隐藏。
- ✅ 聚合卡显示 5 Project groups / 19 of 28 Sessions / 312 Excerpts。
- ✅ Project 名称改为无状态 source chips。
- ✅ Generating 状态恢复 230px Project queue，明确表示逐 bundle 分析。
- ✅ 浏览器验证 Evidence 单列 926px、Generating 为 230px + 696px，均无横向溢出。
