# APP Session 筛选与内容浏览

## 范围与验收标准

- Project Sessions 支持按 session id / source path 搜索，并按 Agent、状态筛选。
- 筛选后的列表继续使用虚拟滚动，只渲染可视行。
- Session 行可点击进入独立详情；返回后保留搜索、筛选和滚动位置。
- 内容按需从源 Session 读取，不写数据库；仅展示脱敏后的 user / assistant 文本与工具名摘要，不展示 tool output、工具参数或 LLM prompt。
- 单次详情最多渲染最近 200 条消息，明确展示总消息数，避免超长 Session 卡住 renderer。

## 步骤节奏

| # | 独立改动 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 1 | 增加 Session 筛选模型与安全内容预览 | 搜索/Agent/状态组合正确；secret 和 tool output 不进入 preview | Core/App 定向单元测试 | ✅ | 2026-07-29 |
| 2 | 实现 Sessions 工具栏、整行点击和详情页 | 筛选后计数正确；点击进入内容；返回保留上下文 | Renderer TypeScript、App build、布局契约测试 | ✅ | 2026-07-29 |
| 3 | 全量回归与上下文同步 | 原虚拟列表和 Projects/Rules 链路无回归 | App/Core tests、build、diff check、更新 `memory/process.md` | ✅ | 2026-07-29 |
| 4 | Session 详情改为层级面包屑并处理主进程版本漂移 | Projects / project / session 层级清晰；旧主进程不再暴露底层 IPC 错误 | App 布局与 IPC 契约测试 | ✅ | 2026-07-29 |
| 5 | 重启 Electron 并回归真实 Session 详情 | 新主进程注册 preview handler，真实详情可加载 | App build、Electron smoke、全量测试、更新 `memory/process.md` | ✅ | 2026-07-29 |

## 未确认假设

- 无。

## 决策记录（活更新，Y-only）

- Session 内容读取放入独立 Worker；即使源文件较大，也不占用 Electron 主进程事件循环。

### 步 4 完成（2026-07-29）
- **影响**：增加真实 Electron 重启验收，覆盖开发态旧主进程仍持有 single-instance lock 的情况。
- **新发现的事实**：截图中的 renderer 已更新，但旧 Electron 主进程和旧 Vite server 仍在运行；新实例被 single-instance lock 退出，因此 IPC handler 没有更新。
- **假设回填**：页面数据或 Session 源损坏 → 已确认不是数据问题，而是开发态主进程版本漂移。
