# APP 最近扫描恢复

## 范围与验收标准

- 应用重启后，Scan 首页从 `run_metadata` 恢复最近一次成功或部分成功的扫描结果。
- 恢复结果包含汇总、项目变化和完成时间；旧记录缺少 `changes` 时兼容为空变化。
- 正在运行的 Scan 仍以 `ScanController` 内存状态为准，不改变后台 Worker 与扫描逻辑。
- 真正从未扫描过时，空状态提供明确的首次扫描入口。

## 步骤节奏

| # | 独立改动 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 1 | 增加最近 Scan run 的只读恢复 | 重启后的 `scan.status` 返回 DB 中最近完成结果 | Scan history 定向单元测试、App build | ✅ | 2026-07-29 |
| 2 | 补全最近结果时间与首次扫描引导 | 已扫描显示完成时间；未扫描可直接进入配置 | Renderer TypeScript、真实 DB 恢复检查、App 全量测试 | ✅ | 2026-07-29 |

## 未确认假设

- 无。

## 决策记录（活更新，Y-only）

### 步 2 完成（2026-07-29）

- **影响**：将 Electron smoke 的数据验证调整为真实 DB 只读恢复检查。
- **新发现的事实**：Computer Use 为可控 Electron 注入隔离 HOME，该实例不能代表用户默认 workspace；真实 `~/.memory-manager/memory.db` 最近 Scan 为 1036 sessions / 3 new / 4 updated。
- **假设回填**：无。
