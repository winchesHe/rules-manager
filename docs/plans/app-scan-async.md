# APP Scan 后台异步化

## 范围与验收标准

- 不修改 core scanner、六个 adapter、分类结果、DB schema 与 CLI 行为。
- Electron main 使用独立 Worker 执行 scan；renderer 发起后立即拿到 started 状态，不等待扫描完成。
- scan 期间导航、设置和其他只读 IPC 仍可响应。
- 同一时刻只允许一个 scan；页面切换或重新进入 Overview 后可通过 status 恢复当前状态。
- progress / done / failed 都有明确事件，失败后互斥状态必须释放。

## 实现步骤

| 步骤 | 独立改动 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|---|
| 1 | 提取可注入 Worker 的 scan 后台任务控制器 | start 立即返回；任务仍在后台运行 | 单元测试使用可控假 Worker，断言 start 返回早于 done | 完成 |
| 2 | `scan.run` 改为立即返回，并新增 `scan.status`，保留事件推送 | 点击 Scan 后 IPC 立即结束；重复点击返回 already-running | controller 定向测试与 TypeScript 检查 | 完成 |
| 3 | Overview 按 status 恢复并消费 done/failed | 扫描中切到其他页面再返回，仍显示 scanning；失败可见 | Electron UI smoke test，扫描期间切换导航和主题 | 完成 |
| 4 | 全量回归与上下文同步 | CLI scan 结果不变，App build 产出 worker | core 全量测试、app build、扩大范围 TS 检查、`git diff --check`；追加 `memory/process.md` | 完成 |

## 验收结果

- App controller：3/3 tests 通过，覆盖立即启动、并发互斥、worker 异常/提前退出。
- Core：22 suites、204/204 tests 通过；core/app production build、扩大范围 TypeScript 检查、`git diff --check` 通过。
- 隔离真实 Electron 扫描 1548 sessions、errors=0。扫描期间 Projects 导航与主题切换可响应；切回 Overview 时恢复到 Codex `300/693` 的实时进度，完成后刷新为 84 个项目。
- UI 验收发现 status 只保存最后一个 agent 的缺口；已改为 `progressByAgent` 六 agent 快照，并增加回归断言。
- 标准 app composite `tsc --noEmit` 仍受既有 core source 跨包 import 的 TS6059/TS6307 阻塞，与本次改动无关，继续沿用 `BLOCKED.md` 记录。
