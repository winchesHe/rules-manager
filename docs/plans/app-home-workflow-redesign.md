# APP 首页工作流重构

## 范围与验收标准

- 将主导航调整为 Scan / Projects / Rules，并按最新确认原型实现渐进式页面。
- Scan 默认展示最近一次扫描结果；新建扫描进入独立配置页，所选 Agents 必须真实传入后台 Worker。
- Projects 首页只负责搜索与筛选；点击后进入项目详情，Sessions 使用数据库查询 + renderer 虚拟列表，Rules 展示该项目候选状态。
- Rules 默认展示候选队列；生成配置、单条审核、产物输出分别进入独立页面。
- 不修改 DB schema、adapter、分类规则和 session 原文安全边界。
- 现有 `rules.output` 仍只生成 `.memory-manager/rules` 安全产物；直接写 Agent system prompt / project memory 不在本轮伪装支持。

## 步骤节奏

| # | 独立改动 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 1 | 锁定 Scan 选择、项目筛选和虚拟窗口的行为契约 | 测试在旧实现失败，明确缺失行为 | App 定向单元测试 | ✅ | 2026-07-29 |
| 2 | 打通 Scan Agent 选择与最新结果页 / 新建扫描页 | 默认只见最新结果；进入配置后可多选 Agents；Worker 收到选择 | controller 测试、renderer TS、App build | ✅ | 2026-07-29 |
| 3 | 实现 Projects 列表页 / 详情页与 Sessions 虚拟列表 | 搜索筛选只影响项目列表；详情只渲染可视 session 行；Rules 可按项目查看 | view-model 测试、renderer TS、App build | ✅ | 2026-07-29 |
| 4 | 实现 Rules 队列 / 生成 / 审核 / 输出页面 | 四种任务不同时挤在一屏；现有 accept/reject/generate/output 链路保持可用 | App 定向测试、renderer TS、App build | ✅ | 2026-07-29 |
| 5 | 全量回归、视觉验收与上下文同步 | dark/light 无溢出，切页恢复正常，无残留进程 | app/core tests、build、diff check、Electron smoke；追加 `memory/process.md` | ✅ | 2026-07-29 |
| 6 | Scan 结果行直达对应 Project Sessions | 点击项目行任意位置进入目标 Project，默认展示 Sessions，具备 hover / pointer / 键盘反馈 | App 布局契约测试、renderer TS、App build | ✅ | 2026-07-29 |
| 7 | 建立最近 7 天 Scan history 只读查询 | 仅返回成功/部分成功记录，按完成时间倒序；旧 summary 可读；变更 session 去重 | Scan history 定向测试 | ✅ | 2026-07-29 |
| 8 | 实现 Scan History 列表与历史结果查看 | Latest scan 可进入 History；点击历史记录复用结果表并可返回 | App 布局契约测试、renderer TS、App build | ✅ | 2026-07-29 |
| 9 | Rules Generate 增加最近 7 天新增/更新 Sessions 范围 | 汇总 7 天内 new/updated、排除 missing、按 session id 去重并只提取目标 session | history/evidence/generate 定向测试、App 布局契约测试 | ✅ | 2026-07-29 |
| 10 | 全量回归与上下文同步 | Scan 全量语义不变；History 与新生成范围无回归 | App/Core tests、build、diff check；追加 `memory/process.md` | ✅ | 2026-07-29 |
| 11 | 修复 Scan History renderer/main 版本漂移提示并重启旧进程 | 新主进程注册 handler；旧进程场景显示重启提示而非底层 remote error | App 布局契约测试、App build、真实进程与 History 查询 smoke | ✅ | 2026-07-29 |
| 12 | 锁定 New Scan 时间窗口与 missing 安全契约 | 最近 X 天只处理窗口内 session，范围外 session 不会被误标 missing | Core/App 定向测试先失败 | ✅ | 2026-07-29 |
| 13 | Core 支持 `sinceDays` 扫描窗口 | Full history 保持完整 missing 对账；最近 X 天跳过范围外 session 和 missing 对账 | Core scan 定向测试 | ✅ | 2026-07-29 |
| 14 | 接通 Worker / IPC / New Scan 时间范围配置 | New Scan 可选 Full history 或最近 X 天，运行状态保留本次范围 | controller、布局契约、renderer TS、App build | ✅ | 2026-07-29 |
| 15 | History 改为全部已完成扫描 | 不再限定最近 7 天；列表展示每次扫描的范围 | history 定向测试、真实 DB 查询 | ✅ | 2026-07-29 |
| 16 | 全量回归、重启与上下文同步 | 新主进程加载新 IPC；Core/App 全绿；真实应用可继续操作 | tests、build、diff check、进程 smoke；追加 `memory/process.md` | ✅ | 2026-07-29 |
| 17 | 锁定 Rules Generate 后台任务契约 | IPC 启动立即返回；运行中互斥；进度、完成和失败由事件驱动 | generation controller 定向测试先失败 | ✅ | 2026-07-29 |
| 18 | 将完整规则生成链路迁入 Worker | evidence 提取和 LLM 生成均不占用 Electron 主线程；状态可查询恢复 | controller/IPC 契约测试、App build | ✅ | 2026-07-29 |
| 19 | 收敛 Generate 页面运行状态布局 | 状态使用紧凑行内区域，不再渲染大块居中 Card | renderer 布局契约、TypeScript、App build | ✅ | 2026-07-29 |
| 20 | 全量回归、重启与上下文同步 | 生成时主界面可继续导航；新主进程加载 Worker handler | App/Core tests、build、diff check、进程 smoke；追加 `memory/process.md` | ✅ | 2026-07-29 |

## 未确认假设

- 最近 X 天按 adapter 发现结果的权威 `updatedAt` 判断；时间窗口扫描不执行 missing 对账，只有 Full history 扫描能确认源文件确实消失。
- 直接写 Agent live instruction source 需要独立安全 spec，本轮明确排除。

## 决策记录（活更新，Y-only）

### 步 7 完成（2026-07-29）

- **影响**：确认无需 schema migration；后续 History UI 与 7 天生成范围统一复用 `run_metadata.details.summary.changes`。
- **新发现的事实**：现有扫描记录已持久化 new / updated / missing 的 session id；旧记录缺少 changes 时可展示总计，但无法可靠恢复具体 session 范围。
- **假设回填**：“最近 7 天 Scan”确认为历史记录时间窗，新建 Scan 仍保持全量遍历。

### 用户澄清（2026-07-29）

- **影响**：上面的“最近 7 天只属于 History”解释已被用户否定；New Scan 必须支持最近 X 天的 session 时间窗口。
- **设计修正**：History 改为全部已完成扫描；Rules 的 `Changed in last 7 days` 仍是独立 evidence 范围，不受本次改动影响。
- **安全决策**：时间窗口扫描无法证明窗口外 DB session 已从源端删除，因此不执行 missing 对账；Full history 扫描继续执行完整 missing 对账。

## 完成记录

- 实际交付：Scan / Projects / Rules 渐进式首页工作流、真实 Agent 扫描范围、项目详情与虚拟 Sessions、按近期 / 全量 / 指定项目生成规则、单条审核与安全产物输出。
- 安全边界：未修改 DB schema、adapter、分类规则；未直接写 Agent system prompt / project memory。
- 验证结果：App 5 suites / 15 tests、Core 23 suites / 213 tests、Core/App build、renderer 扩大 rootDir TypeScript、diff check 全通过。
- 真实观察：Electron 中验证三页切换、Scan 配置、306 sessions 虚拟列表、Rules Generate；修复长 Projects 表格造成的全局横向偏移，测试进程已清理。

### 最近 7 天 History 与规则生成补充

- Scan 新增最近 7 天 History 列表与历史结果查看；每次新 Scan 仍为全量扫描。
- Rules Generate 新增最近 7 天 changed sessions 范围，只包含 Scan 标记的 new / updated，按 session id 去重并排除 missing。
- 默认真实 workspace 只读观察到 7 条历史扫描、1179 个去重变更 sessions，最近一条完成于 `2026-07-29T07:34:11.379Z`。
- 验证结果：App 7 suites / 30 tests、Core 23 suites / 218 tests、Core/App build、renderer 扩大 rootDir TypeScript 与 diff check 全通过。
