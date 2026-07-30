# Generation Run Paseo UI 实施计划

## 范围与验收

- 仅修改任务书白名单文件，不新增依赖、IPC channel、schema 或同步主线程工作。
- 左侧 Run progress 是唯一阶段导航；Generate candidates 同屏展示 Process 与项目化 Agent output。
- Evidence 以 Project 为第一层，Sessions 保留虚拟滚动与按需脱敏 Preview。
- 每个项目完成即产生有界、可序列化的结构化响应；Controller 可从 status 恢复且返回 defensive copy。
- 取消前的结构化预览保持可见，但 Core 只在最终事务边界写 Draft。

## 可观察数据

- Evidence snapshot：冻结本次 run 的项目、Session 技术 ID、轮次与 excerpt 数量，不包含 Session 原文。
- Project response：项目标识、自然语言摘要、候选的 Rule、Scope、Confidence、Reasoning 与 Evidence refs。
- Process event：阶段、当前项目、候选累计数、重试/拆分等生成活动。
- Diagnostic：有长度上限的 Provider raw assistant output，默认折叠，不作为主内容。
- UI memory：当前选中阶段与对话滚动位置仅保留在 renderer 内存，不写 DB。

## 步骤节奏

| 步骤 | 状态 | 观察点 | 验证方式 | reviewed |
|---|---|---|---|---|
| 1. 用测试冻结结构化项目响应、恢复与 UI 交互契约 | ✅ | 新测试在旧实现上因缺少 project response、阶段按钮和详情入口而失败 | 定向运行 Core/App 新增测试并保留失败输出 | 2026-07-29 |
| 2. 打通 Core → Worker → Controller 的有界结构化响应 | ✅ | 每个项目完成立即出现响应；status 保持顺序、取消预览和深层 defensive copy | 定向 Core/App controller 测试全绿，确认取消无 Draft | 2026-07-29 |
| 3. 按原型重做 Generation Run | ✅ | 无顶部 Tabs；四阶段均可点击且唯一选中；Generate 为 Process + 项目对话；Evidence 为 Project-first；Candidate 可打开只读详情 | App 布局契约测试全绿，并检查 Diagnostic 默认折叠 | 2026-07-29 |
| 4. 全量验收与上下文同步 | ✅ | Core/App 测试数不低于基线，两个 build 与 diff check 全绿，BLOCKED/process/PROGRESS 完整 | 执行任务书五条验收命令并记录实际输出 | 2026-07-29 |
| 5. 补齐 Candidate 弹窗标题与键盘关闭 | ✅ | 标题明确标注 Project；右上角为 X；按 Esc 调用关闭且卸载时移除监听 | 布局契约测试断言 Project、X、keydown 注册/清理，App build 通过 | 2026-07-29 |
| 6. 修正新 Run 的初始阶段 | ✅ | 新 runId 无 UI 记忆时选中 Prepare evidence；已有记忆仍恢复原阶段 | 布局契约锁定 evidence fallback，并跑 App 全量测试与 build | 2026-07-30 |

## 未确认假设

- Validate / Save drafts 复用 Generate candidates 内容，仅改变左侧唯一选中态；后续可扩展独立内容。
- Candidate 详情采用只读弹窗，不提供 Accept / Reject。
- renderer 切换主导航后的阶段与滚动位置使用进程内 runId 记忆；结构化内容本体以 Controller status 为恢复来源。

## 决策记录（活更新）
