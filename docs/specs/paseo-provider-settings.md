# paseo-provider-settings

## 概述

把现有单页表单式 Settings 改造成 Paseo 风格的 Provider 管理中心：第一层展示 Provider 可用性、模型数量、启用状态；第二层展示单个 Provider 的模型目录、搜索、刷新、诊断和自定义模型管理。

核心目标：

1. 用户打开 Settings 后，先看清“哪些规则生成 Provider 可用、启用了哪些、各有多少模型”，而不是先面对三个孤立表单项。
2. Provider 和模型状态来自真实本机探测；加载、可用、不可用、失败、禁用都有明确状态，不用静态假数据伪装。
3. 用户可在 Provider 详情中搜索发现模型、添加自定义模型、查看诊断、强制刷新，并明确选择规则生成所用的默认 Provider / Model。
4. 保持本地优先：配置仍写入 `<workspace>/config.json`，不上传凭据、不保存诊断中的敏感内容。

## 非目标

首版不做以下能力：

1. 不把 Claude / Codex 之外的 session adapter 冒充成规则生成 Provider。Copilot、OpenCode、Pi 只有在 `llm.ts` 实现真实调用链后才加入列表。
2. 不照搬 Paseo 的 daemon、remote host、ACP profile、OMP 或跨主机 provider snapshot 架构。
3. 不在 UI 中收集 API Key、OAuth token 或其他凭据；沿用本机 CLI / SDK 已有认证。
4. 不实现 Provider 安装、登录或自动修复，只提供可执行的本机诊断信息。
5. 不改 scan、session adapter、rule candidate DB schema 或 CLI scan 行为。

## 产品结构

### Provider 列表

Settings 主弹窗改为 Paseo P2 的列表结构：

- 标题：`Providers`
- 每行：展开箭头、Provider 图标、名称、状态点、状态文案、模型数量、启用开关。
- 首版内置 `Claude`、`Codex` 两行。
- 状态：
  - `loading`：正在探测；
  - `available`：命令 / SDK 可用且模型目录成功；
  - `not-installed`：本机入口不可用；
  - `error`：入口存在但探测失败；
  - `disabled`：用户关闭。
- 可用 Provider 行可进入详情；不可用/失败行仍可进入详情查看诊断。
- 至少保留一个启用 Provider；当前默认 Provider 不能直接关闭，需先把另一个 Provider 设为默认。
- 默认 Provider 在名称后展示 `Default` 标记，这是本项目为保留规则生成确定性而增加的状态，Paseo 截图本身没有该标记。

### Provider 详情

点击 Provider 后打开 Paseo P3 风格大弹窗：

- Header：Provider 名称、关闭按钮、模型搜索框。
- Body：
  - `Discovered` 分区展示本机探测模型；
  - `Custom` 分区展示用户追加模型；
  - 每行展示 label、model id、description/source；
  - 当前规则生成默认模型展示 selected 状态；
  - 点击模型把该 Provider + Model 设为默认；
  - 搜索覆盖 label、id、description，结果按精确前缀优先。
- Footer：最近更新时间、`Add model`、`Diagnostic`、`Refresh`。
- 刷新期间保留旧模型列表，避免 UI 闪空；刷新失败保留旧列表并显示 error。

### Add model

`Add model` 打开子弹窗：

- 必填 model id；
- 可选 label；
- 自动 trim，Provider 内 model id 唯一；
- 与 discovered model 同 id 时作为 label override，不重复显示两行；
- 保存后原子写 config，再刷新当前详情。

### Diagnostic

`Diagnostic` 打开只读子弹窗，展示：

- Provider 名称和探测时间；
- 可执行入口是否解析成功；
- CLI / SDK 版本；
- 认证只展示 boolean / 状态，不展示 token、路径内敏感内容或环境变量值；
- 模型发现成功数量或失败原因；
- 一键复制前必须使用已脱敏文本。

## 架构与数据流

```text
SettingsModal
  ├─ settings.providers.snapshot ──> ProviderCatalogService
  │                                  ├─ ClaudeProviderProbe
  │                                  └─ CodexProviderProbe
  ├─ settings.providers.refresh  ──> 后台 probe worker
  ├─ settings.providers.diagnostic -> 脱敏诊断
  └─ settings.save              ──> config.json 原子写

config.json ──> rules generate ──> 默认 enabled provider + selected model + effort
```

Provider 探测不得跑在 Electron main 线程。首次打开返回缓存快照或 `loading` 状态，刷新在 Worker 中执行，通过事件或短轮询更新 UI；模型发现失败不能卡死 Settings 和其他 App 操作。

Generation defaults 对 Claude 与 Codex 共用：

- `effort` 支持 `low / medium / high / xhigh / max`；
- `fastMode` 在 Claude 调用中映射为 SDK `settings.fastMode`；
- `fastMode` 在 Codex 调用中映射为 `service_tier=priority/default`；
- Settings 不因默认 Provider 是 Codex 而禁用 Fast Mode。

## 数据模型

```ts
type GenerationProviderId = 'claude' | 'codex'
type ProviderStatus = 'loading' | 'available' | 'not-installed' | 'error' | 'disabled'

interface ProviderModel {
  id: string
  label: string
  description?: string
  source: 'discovered' | 'custom'
}

interface ProviderSnapshotEntry {
  id: GenerationProviderId
  label: string
  status: ProviderStatus
  enabled: boolean
  isDefault: boolean
  models: ProviderModel[]
  fetchedAt?: string
  error?: string
}

interface ProviderDiagnostic {
  provider: GenerationProviderId
  checkedAt: string
  executable: { available: boolean; version?: string }
  authenticated: boolean | 'unknown'
  catalog: { ok: boolean; modelCount?: number; error?: string }
  text: string
}

interface LlmConfig {
  provider: GenerationProviderId
  model?: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  fastMode?: boolean
  providers?: Partial<Record<GenerationProviderId, {
    enabled: boolean
    additionalModels?: Array<{ id: string; label?: string }>
  }>>
}
```

兼容策略：

- 旧配置只有 `provider/model/effort` 时继续可读。
- 缺少 `providers` 时 Claude、Codex 默认 enabled，`provider` 仍是默认 Provider。
- 保存新配置时保留顶层 `provider/model/effort`，避免破坏现有 CLI `rules generate`。
- 不新增 DB 表，不做 schema migration。

## Provider 探测策略

### Claude

- 可用性：SDK / Claude CLI 入口能够解析。
- discovered models：优先使用 Claude SDK 支持的模型目录；若 SDK 无稳定目录接口，则使用项目内维护的 Claude 基础目录并合并 `~/.claude/settings.json` 中显式 model 配置。
- 诊断不得发起真实付费生成请求。

### Codex

- 可用性：`codex` 可执行文件可解析且版本命令成功。
- discovered models：优先使用 Codex app-server 的 model list 协议；若当前本机版本不支持，则返回项目内维护的兼容目录并在 diagnostic 标明来源。
- 诊断不得提交 prompt，不读取或输出 auth token。

### 缓存

- 进程内按 Provider 保存最后成功 snapshot。
- 打开 Settings 先返回缓存，后台检查是否过期。
- 强制 Refresh 忽略 TTL。
- 刷新中的空结果不覆盖最后成功模型；明确成功且模型为空时才更新为空。

## IPC 接口设计

```ts
type ProviderSnapshotResponse = {
  entries: ProviderSnapshotEntry[]
  refreshing: boolean
}

window.api.invoke('settings.providers.snapshot')
window.api.invoke('settings.providers.refresh', providerId?)
window.api.invoke('settings.providers.diagnostic', providerId)
window.api.invoke('settings.providers.setEnabled', providerId, enabled)
window.api.invoke('settings.providers.selectModel', providerId, modelId?)
window.api.invoke('settings.providers.addModel', providerId, { id, label? })
window.api.invoke('settings.providers.removeModel', providerId, modelId)
```

长耗时 refresh / diagnostic 使用后台 Worker；IPC 立即返回 started/status，结果通过：

```text
settings.providers.updated
settings.providers.failed
```

推送给 renderer。preload 继续使用现有 channel 精确配对的 `onEvent/offEvent`。

## 配置与安全策略

1. `config.json` 继续使用同目录临时文件 + rename 原子写。
2. 自定义 model 只允许非空单行字符串，限制长度，拒绝控制字符。
3. 诊断只返回 allowlist 字段；stderr 需要长度上限和 secret redaction。
4. 不读取或传输对话原文、tool output、LLM prompt。
5. 不通过诊断触发真实模型生成，不把诊断结果持久化到 DB。
6. Provider 禁用只影响规则生成入口，不影响 session scan adapter。

## 改动范围

- `packages/core/src/config.ts`
  - 非破坏式扩展 provider 配置与校验，保留顶层默认项。
- `packages/core/src/provider-catalog.ts`（新增）
  - Provider manifest、模型合并、snapshot、诊断脱敏纯逻辑。
- `packages/app/main/provider-worker.ts`（新增）
  - 在后台执行可用性、模型目录和诊断探测。
- `packages/app/main/provider-controller.ts`（新增）
  - 缓存、互斥、TTL、事件和 Worker 生命周期。
- `packages/app/main/ipc.ts`
  - 注册 provider snapshot / refresh / diagnostic / mutation IPC。
- `packages/app/electron.vite.config.ts`
  - 增加 provider worker 构建入口。
- `packages/app/renderer/src/components/SettingsModal.tsx`
  - 替换现有三字段表单，成为 Provider 列表容器。
- `packages/app/renderer/src/components/ProviderDetailsModal.tsx`（新增）
  - 模型搜索、分区列表和 footer actions。
- `packages/app/renderer/src/components/ProviderDiagnosticModal.tsx`（新增）
  - 只读脱敏诊断。
- `packages/app/renderer/src/components/AddProviderModelModal.tsx`（新增）
  - 自定义模型新增表单。
- `packages/app/renderer/src/types.ts`
  - 增加 provider snapshot / model / diagnostic 类型。
- `packages/app/test/`
  - controller、模型合并、配置兼容和 Worker 失败回归。
- `memory/process.md`
  - 完成后同步关键决策与真实验收。

## 假设

- ⚠ 用户给出的 P2/P3 是交互和视觉参考，不要求复制 Paseo 的 remote host / daemon 架构。
- ⚠ 首版只管理当前真实可用于规则生成的 Claude、Codex；Copilot/OpenCode/Pi 等待生成调用链实现后再接入。
- ⚠ “启用”允许多个 Provider 同时开启，但 `provider/model` 始终只有一个默认组合供当前无参数的 Generate 使用。
- ⚠ `Add model` 只增加本地 catalog 配置，不安装模型，也不验证远端模型一定可调用。

## 风险

- 不同 Claude/Codex 版本的模型发现接口可能变化。兜底：静态兼容目录 + 明确 diagnostic source，不能把 fallback 标成 runtime discovered。
- Provider 探测可能启动 CLI 并卡住。兜底：Worker 隔离、超时、单 Provider 互斥、进程终止和最后成功缓存。
- 多 Provider 启用与单默认项容易混淆。兜底：主列表显示 Default 标记，模型点击动作明确写“设为默认”。
- 自定义 model id 可能无效。兜底：标记 Custom，不声称 Available；真正 Generate 失败时保留原有可见错误。
- Settings 改造可能破坏已有 config。兜底：旧配置兼容测试、原子保存、core 全量回归和真实 CLI generate dry-run。

## 验收链路

```bash
npm test --workspace @memory-manager/app -- --runInBand
npm test --workspace @memory-manager/core -- --runInBand
npm run build --workspace @memory-manager/app
npm run build --workspace @memory-manager/core
```

真实 Electron 必须证明：

1. Settings 第一层呈现 Claude/Codex Provider 行、真实状态、模型数量、启用开关和默认标记。
2. 探测期间导航、主题切换和关闭 Settings 仍可响应。
3. 点击 Provider 进入详情，搜索能筛选 label/id/description。
4. Refresh 保留旧列表直到新结果成功；失败显示 error 且旧模型不消失。
5. Diagnostic 不包含 token、prompt、对话原文或完整敏感环境变量。
6. Add model 保存后重开仍存在；删除只允许删除 custom model。
7. 选择模型后 `config.json` 顶层 provider/model 更新，`rules generate --dry-run` 使用该组合。
8. 禁用非默认 Provider 不影响 scan；默认 Provider 不能在无替代项时关闭。
9. dark/light 两种主题下层级、边框、hover、disabled、loading 和错误状态都可辨认。

## 后续实现顺序

1. 搭出 config 兼容、ProviderSnapshot 类型和 Claude/Codex 假 probe 的端到端最小骨架，让 Settings 能显示真实 loading→result 状态。
2. 实现 Provider controller + Worker 隔离、缓存、互斥、超时和事件。
3. 接入 Claude/Codex 可用性、模型发现和脱敏诊断。
4. 重构 Settings Provider 列表并完成 enabled/default 交互。
5. 实现 Provider 详情、模型搜索、选择和刷新。
6. 实现 Add model、Custom 合并/删除和配置持久化。
7. 实现 Diagnostic 子弹窗和复制。
8. 完成双主题、失败态、切页恢复、真实 Electron 与 CLI 回归。

## 参考

- 本机验收截图不纳入公开仓库；以本文档中的字段合同和自动化测试为准。
- Paseo 本地参考：
  - `packages/app/src/screens/settings/providers-section.tsx`
  - `packages/app/src/components/provider-diagnostic-sheet.tsx`
  - `docs/providers.md`
