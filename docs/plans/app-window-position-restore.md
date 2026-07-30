# APP 窗口位置与大小恢复

## 范围与验收标准

- 持久化 Electron 主窗口最后一次普通状态下的位置与尺寸 `{x, y, width, height}`，不记录最大化、全屏或多窗口状态。
- 用户移动或缩放窗口并完全退出应用后，再次启动应恢复到上次位置与大小。
- 兼容已有 `{x, y}` 状态文件：继续恢复位置，尺寸使用 BrowserWindow 默认值。
- 保存数据损坏、字段非法或原显示器已移除时，应用仍正常启动，并使用现有默认位置。
- 不修改 renderer、core、数据库 schema 或工作区配置。

## 步骤节奏

| # | 独立改动 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 1 | 锁定位置读写与屏幕安全判断契约 | 旧实现没有窗口位置存储模块，定向测试失败 | App 窗口位置定向测试 | ✅ | 2026-07-29 |
| 2 | 接入 BrowserWindow 启动恢复与移动保存 | 创建窗口时使用有效坐标；移动/关闭时保存普通状态位置 | App 全量测试、renderer TypeScript、App build | ✅ | 2026-07-29 |
| 3 | 全量回归与上下文同步 | core 行为无变化，构建产物可生成 | core/app tests、build、`git diff --check`；追加 `memory/process.md` | ✅ | 2026-07-29 |
| 4 | 补充普通窗口尺寸持久化 | move/resize/close 保存完整 bounds；新状态恢复尺寸，旧位置文件仍兼容 | App 窗口状态定向测试、App 全量测试/build、`git diff --check` | ✅ | 2026-07-30 |

## 未确认假设

- 无。尺寸与位置一起保存，但仍不扩展为最大化、全屏或多窗口状态管理。

## 决策记录（活更新，Y-only）

## 完成记录

- 实际交付：主窗口普通状态位置持久化、启动恢复，以及显示器布局变化和损坏状态的安全回退。
- 范围保持：未记录窗口尺寸、最大化、全屏或多窗口状态；renderer、core 与 DB 均未修改。
- 自动验证：App 7 suites / 23 tests、renderer 扩大范围 TypeScript、App/Core build 与 Core tests 全通过。
- 真实观察：预置 `(400, 180)` 后启动并正常退出，位置文件仍为 `(400, 180)`；测试状态和临时进程均已清理。

## 2026-07-30 补充轮

- 用户要求重新打开时同时恢复普通窗口尺寸；旧的“明确不记录尺寸”约束由本轮覆盖。
- 观察点：保存文件出现 width/height，BrowserWindow 恢复完整 bounds，resize 会触发保存。
- 验证方式：先用新增契约证明旧实现失败，再跑定向测试、App 全量测试、production build 与 diff check。
- 结果：状态扩展为 `{x,y,width,height}`，兼容旧 `{x,y}`；App 定向 9/9、全量 8 suites / 50 tests、production build 与 `git diff --check` 全通过。
