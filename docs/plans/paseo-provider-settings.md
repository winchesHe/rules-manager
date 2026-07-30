# paseo-provider-settings — Plan

> 实现节奏 + 关键设计。完成后由 `flow-ship` 归档到 `docs/plans/done/`。
> spec：`docs/specs/paseo-provider-settings.md`

## 目标

把当前三字段 Settings 改为真实可用的 Paseo 风格 Provider 管理中心，在不破坏现有规则生成配置的前提下，提供 Claude/Codex 可用性、模型目录、启用/默认状态、搜索、刷新、自定义模型和脱敏诊断。

## 最小可验证链路

```bash
npm test --workspace @memory-manager/app -- --runInBand
npm run build --workspace @memory-manager/app
```

期望行为：

```text
Settings 打开后先显示 Provider 列表；探测在后台完成；Provider 详情可搜索模型并刷新。
```

## 关键设计

- **行为**：Provider 列表承担总览，Provider 详情承担模型目录和诊断；默认 Provider/Model 继续驱动现有 Generate。
- **处理流程**：加载兼容配置 → 返回缓存 snapshot → Worker 探测 → 合并 discovered/custom → renderer 更新 → 用户 mutation 原子保存配置。
- **状态机**：loading → available / not-installed / error；用户关闭后为 disabled。刷新期间保留最后成功模型。
- **业务输入输出**：输入为本机 Provider 入口、旧配置与 custom models；输出为脱敏 Provider snapshot、诊断和兼容 `config.json`。
- **模块间调用关系**：Settings UI → IPC → ProviderController → Worker/Core catalog → 本机 Claude/Codex；配置 mutation → core config → Generate。

## 实施者警告

- Chunk 1 完成前 UI 不改，先用测试和 IPC smoke 证明后台 catalog 链路。
- 标准 app composite typecheck 有既存 core 跨包 TS6059/TS6307；每步使用扩大范围 bundler TypeScript 检查，不能把既存错误误判为本轮回归。
- 第一次真实 UI 验收放在 Chunk 3，最终再跑 core/app 全量。

## Chunk 划分

### Chunk 1: 配置与后台目录骨架

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 1.1 | 建立 config 兼容、catalog 合并和后台 controller 的端到端最小骨架 | 假 Worker 返回 loading→available，旧 config 仍可读取 | App/core 定向测试；controller snapshot 断言 | ✅ | 2026-07-29 |
| 1.2 | 接入 Worker 构建和 Provider IPC | production build 产出 provider-worker；refresh 立即返回 | App build；IPC/controller 测试 | ✅ | 2026-07-29 |

**Observability Checkpoint**：

- **运行命令**：`npm test --workspace @memory-manager/app -- --runInBand && npm run build --workspace @memory-manager/app`
- **期望输出关键字**：`PASS`、`provider-worker.js`
- **失败常见根因**：Worker bundle 未声明入口、Electron SQLite alias 未继承、消息类型不可结构化克隆。

### Chunk 2: 真实探测与配置 mutation

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 2.1 | 实现 Claude/Codex 可用性、模型目录和脱敏诊断 | snapshot 展示真实版本、模型数量或明确 fallback source | Core 定向测试；本机 probe smoke | ✅ | 2026-07-29 |
| 2.2 | 实现启用、默认模型、自定义模型增删的兼容保存 | 重开后状态保持，旧顶层 provider/model 同步 | config/mutation tests；隔离 config 文件断言 | ✅ | 2026-07-29 |

**Observability Checkpoint**：

- **运行命令**：Provider probe smoke + `npm test --workspace @memory-manager/core -- --runInBand`
- **期望输出关键字**：Claude/Codex 各自状态、`204 passed` 或更新后的全量数
- **失败常见根因**：本机 CLI 版本差异、auth 误判、custom/discovered 去重不稳定、旧 config 校验过严。

### Chunk 3: Paseo 风格 UI

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 3.1 | 重构 Settings 为 Provider 列表与详情模型浏览 | P2/P3 层级、状态、数量、搜索、刷新均可见 | App build + Electron dark/light UI 验收 | ✅ | 2026-07-29 |
| 3.2 | 完成 Add model、Diagnostic、失败态与切页恢复 | 自定义模型可持久化；诊断无 secret；后台刷新不阻塞 App | Electron 真实操作 + 配置/诊断断言 | ✅ | 2026-07-29 |

**Observability Checkpoint**：

- **运行命令**：隔离 HOME 启动 Electron，打开 Settings、切换 Provider、搜索、刷新、添加/删除模型、查看诊断
- **期望输出关键字**：`Available`、模型数量、`Discovered`、`Custom`、`Updated`
- **失败常见根因**：HeroUI v3 组合 API差异、事件在 Modal 卸载时丢失、refresh 覆盖最后成功缓存。

### Chunk 4: 全量收尾

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 4.1 | 完成全量回归、视觉对账和 process 同步 | core/CLI 无回归，Paseo 关键层级一致，无残留进程 | core/app tests、build、TS、diff check、Electron smoke | ⏳ | —— |

### Chunk 3.3: Generation defaults 与详情 Footer 修正

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 3.3.1 | 扩展 Effort 五档并把 Fast Mode 串入 Claude 实际生成调用 | 配置可保存 `xhigh/max` 与 fastMode；Claude query 收到对应 options/settings | config、LLM、generate 定向测试 | ✅ | 2026-07-29 |
| 3.3.2 | 重排 Generation defaults 与 Provider 详情 Footer | 设置卡展示 Effort + Fast Mode；Footer 时间与按钮分组稳定、窄屏可换行 | renderer TS、App build、Electron UI 验收 | ✅ | 2026-07-29 |
| 3.3.3 | 把 Fast Mode 串入 Codex 实际生成调用 | `true` 映射 `service_tier=priority`，`false` 映射 `service_tier=default`，覆盖用户全局 tier | LLM 定向测试 | ✅ | 2026-07-29 |
| 3.3.4 | Settings 改为 Claude / Codex 共用 Fast Mode | 两个 provider 下开关均可用，文案不再限定 Claude | Settings 契约测试、renderer TS、App build | ✅ | 2026-07-29 |

**Observability Checkpoint**：

- **运行命令**：core 定向测试 + `npm run build --workspace @memory-manager/app`
- **期望输出关键字**：五档 Effort、`fastMode: true`、Footer 左右分组且无异常空隙
- **失败常见根因**：SDK `fastMode` 被误放到 query 顶层而非 settings、旧 config 精确相等断言回归、HeroUI Footer 默认 flex 规则覆盖子元素布局。

### Chunk 3.4: 无边框窗口拖动修复

| # | 步 | 观察点 | 验证方式 | 状态 | reviewed |
|---|---|---|---|---|---|
| 3.4.1 | 为 hiddenInset 窗口恢复顶部拖动命中区并保护交互控件 | 主界面、Settings、Modal 顶部可拖动；按钮与输入仍可点击 | App 定向测试、build、Electron 实际拖动 | ✅ | 2026-07-29 |

**Observability Checkpoint**：

- **运行命令**：`npm test --workspace @memory-manager/app -- --runInBand` + Electron 拖动前后窗口坐标对比
- **期望输出关键字**：拖动区域包含 `-webkit-app-region: drag`，窗口位置发生变化，交互控件为 `no-drag`
- **失败常见根因**：只设置 hiddenInset 未声明 drag region、拖动层 z-index 太低、drag region 覆盖按钮导致点击失效。

**Observability Checkpoint**：

- **运行命令**：spec 验收链路全部命令
- **期望输出关键字**：全部测试通过、两份 build 成功、`git diff --check` 无输出
- **失败常见根因**：旧 config fixture 不兼容、worker 原生依赖 ABI、测试进程未清理。

## 风险点 + 兜底

- Provider 目录接口跨版本不稳定 —— 优先真实接口，失败时使用明确标注来源的兼容目录。
- CLI probe 卡住 —— Worker 隔离、超时、退出清理和最后成功缓存。
- 多启用项与单默认项混淆 —— Default 标记和模型选择文案明确同步顶层配置。
- 自定义模型无效 —— 标记 Custom，只在实际 Generate 时验证调用。

## 验收

```bash
npm test --workspace @memory-manager/app -- --runInBand
npm test --workspace @memory-manager/core -- --runInBand
npm run build --workspace @memory-manager/app
npm run build --workspace @memory-manager/core
```

必须证明：

1. Provider 探测和刷新不阻塞 Electron。
2. P2/P3 的列表→详情信息架构完整落地。
3. 配置兼容、默认选择、自定义模型和诊断满足 spec。
4. scan、Generate 与 CLI 无回归。

## 非目标

- 不接入 Copilot/OpenCode/Pi 规则生成。
- 不实现安装、登录、远端 host 或凭据管理。
- 不改 DB schema 和 scan adapter。

## 决策记录（活更新，Y-only）

### 步 1.2 完成（2026-07-29）
- **影响**：为证明 Worker bundle 可实际执行，Claude SDK 与 Codex app-server 的目录探测已随骨架接入；步 2.1 收窄为真实 smoke、fallback 来源与诊断补齐。
- **新发现的事实**：本机 Codex 0.142.2 提供稳定的 app-server `model/list` JSON-RPC；Claude SDK Query 提供 `supportedModels()`，两者都无需发送生成 prompt。
