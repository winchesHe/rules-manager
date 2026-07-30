# APP i18n 第一期（简体中文 / 英文）

## 范围与验收标准

### 本期目标

- APP Renderer 支持 `zh-CN` 与 `en-US` 两种语言，首次安装和没有有效偏好时默认 `zh-CN`。
- Settings 新增 `General` 页面与语言选择项，用户切换后当前窗口立即生效，不需要重启。
- 语言偏好只属于当前设备的 APP UI，不进入 workspace `config.json`、SQLite、规则文件或 Session 索引。
- 重启 APP 后恢复上次选择；持久化值缺失、损坏或不是受支持语言时安全回退 `zh-CN`。
- 导航、页面标题、按钮、表单、状态、空态、错误兜底、Tooltip、`aria-label` 和日期/数字格式随语言切换。
- `document.documentElement.lang` 与当前语言一致；两种语言当前均为 LTR。

### 本期不做

- 不翻译 CLI、Core 日志、数据库内容、项目 slug、Session ID、文件路径、Agent / Provider / Model 品牌名。
- 不翻译用户编辑的 rule、Agent instruction、Session preview、Agent output、Evidence 原文或 Provider 原始诊断。
- 不按操作系统语言自动选择；产品要求“默认中文”，因此只有用户显式切换后才使用英文。
- 不引入在线翻译、远程语言包、地区选择、RTL、繁体中文或中英文之外的语言。
- 不在本期重构 Main/Core 的错误协议。稳定的 UI 错误标题与兜底文案要翻译；Main/Core 返回的动态技术错误保留原文，作为诊断详情展示。

### 完成定义

1. 全新用户打开 APP 时所有本期覆盖的 UI 默认为简体中文。
2. 在 `设置 → 通用 → 语言` 选择 `English` 后，当前页面、主导航、弹窗与无障碍标签立即变为英文。
3. 退出并重新打开 APP 后仍为上次选择的语言。
4. 手工写入非法语言偏好后启动 APP，不报错且恢复为简体中文。
5. `zh-CN` / `en-US` 的资源 key 完全一致、值非空，缺 key 时运行时回退中文。
6. 所有日期和数字通过当前 locale 格式化，不再使用 `toLocaleString()` / `Intl.DateTimeFormat(undefined, ...)` 的隐式系统 locale。
7. 900×620 最小窗口和 1280×800 默认窗口下，中英文均无页面级横向溢出，关键按钮不截断。
8. Core 行为、DB schema、隐私边界、后台 Run 状态机和生成结果不发生变化。

## 设计决策

### 1. Locale 模型

```ts
export const supportedLocales = ['zh-CN', 'en-US'] as const
export type AppLocale = (typeof supportedLocales)[number]
export const defaultLocale: AppLocale = 'zh-CN'
```

- 内部只使用完整 BCP 47 tag，避免 `zh`、`cn`、`en` 等别名进入状态。
- 语言选择器展示自描述名称：`简体中文`、`English`。这些名称不随当前语言翻译，用户切错语言后仍能识别。
- 资源缺失回退链固定为：当前语言 → `zh-CN` → key；开发和测试环境对缺 key 给出明确告警。

### 2. 技术选型

采用 `i18next` + `react-i18next`：

- React 组件通过 `useTranslation(namespace)` 读取文案，语言变化能触发现有页面即时重渲染。
- 支持插值、英文复数和 namespace，适合当前约 6,000 行 Renderer 与大量数量型文案。
- 不把中文或英文句子本身当 key，使用稳定的语义 key，例如：

```ts
t('projects:summary.sessions', { count: project.sessionCount })
t('scan:range.recentDays', { count: days })
t('common:actions.back')
```

- 不自研全局字符串替换器，也不在组件里写 `locale === 'zh-CN' ? ... : ...`。

### 3. 资源组织

```text
packages/app/renderer/src/i18n/
├── index.ts                  # i18next 初始化、支持语言与默认语言
├── locale.ts                 # AppLocale 校验、读取/保存偏好
├── format.ts                 # 日期、时间、数字、字节等 locale-aware formatter
└── locales/
    ├── zh-CN/
    │   ├── common.json
    │   ├── navigation.json
    │   ├── scan.json
    │   ├── projects.json
    │   ├── rules.json
    │   └── settings.json
    └── en-US/
        ├── common.json
        ├── navigation.json
        ├── scan.json
        ├── projects.json
        ├── rules.json
        └── settings.json
```

Namespace 按业务页面拆分，避免 `RulesView.tsx` 的大量文案继续堆进单一资源文件。共享 action、状态和错误兜底放 `common`；同一个概念在不同业务语境含义不同时，保留各自 namespace 的 key。

以下内容保持原值，不进入字典：

- `Memory Manager`
- `Claude / Codex / Copilot / Cursor / OpenCode / Pi`
- Provider / Model 名称
- project slug、Session ID、branch、路径、文件名
- rule、instruction、preview、Agent output 等用户或外部生成内容

### 4. 启动与持久化

一期使用 Renderer 的 `localStorage` 保存本机 UI 偏好：

```text
key: memory-manager.locale
value: zh-CN | en-US
```

选择理由：

- 语言只影响单窗口 Renderer，不需要 Main、Worker 或 Core 消费。
- 同步读取，可在 `createRoot` 前完成初始化，避免英文用户启动时先闪现中文。
- 不污染目前仅承载 LLM 设置的 workspace `config.json`，也不需要新增 IPC 或 DB schema。

启动顺序：

1. 从 `localStorage` 读取并校验 locale。
2. 无值或非法值使用 `zh-CN`。
3. 初始化 i18next。
4. 同步设置 `<html lang>`。
5. 再挂载 React。

切换顺序：

1. 校验新 locale。
2. `i18n.changeLanguage(locale)`。
3. 更新 `<html lang>`。
4. 写入 `localStorage`。

如果写入失败，当前会话仍完成切换，但显示可恢复的设置保存错误；下次启动回退已持久化值或中文。

### 5. Settings 信息架构

Settings 左侧改为：

```text
App
├── 通用 / General
├── Providers
└── 关于 / About
```

- 默认进入 `通用 / General`。
- 通用页第一组为 `语言 / Language`，使用单选 Select。
- 选择项固定显示 `简体中文` 与 `English`。
- 辅助说明明确“更改会立即生效”。
- Providers、About 的现有功能和配置保存链路不变。

### 6. 日期、数字与复数

新增集中 formatter，组件不得直接依赖系统 locale：

```ts
formatDateTime(value, locale)
formatDate(value, locale)
formatNumber(value, locale)
formatBytes(value, locale)
```

- `Intl.DateTimeFormat` / `Intl.NumberFormat` 必须显式传入当前 locale。
- 时间保持本机时区，只改变显示语言与格式。
- 英文数量文案使用 i18next plural key；中文使用同一调用，不在 JSX 中手写 `count === 1`。
- 状态枚举通过映射 key 翻译，不能直接把 `draft / accepted / missing / running` 作为 UI 文案输出。

### 7. 错误与诊断

- Renderer 自己定义的错误标题、兜底说明、恢复操作全部进入字典。
- Main/Core 当前只返回字符串错误，第一期不通过匹配英文/中文消息来猜错误类型。
- 动态技术错误可作为详情保留原文；用户首先看到本地化的稳定标题与下一步操作。
- 后续若需要 Main/Core 完整本地化，应另开一轮，把 IPC 错误升级为稳定 error code + params，再由 Renderer 翻译。

### 8. 可访问性与布局

- `aria-label`、Tooltip、Modal 标题、表格 accessible name、加载/空态文案都必须使用翻译资源。
- 图标、品牌和纯技术值不需要翻译。
- 中文默认字体继续使用系统字体栈，不新增字体包。
- 以英文作为长度压力基线，同时检查中文无异常断行；禁止通过缩小字号解决溢出。

## 测试策略

### 资源契约

- 两个 locale 的 namespace 集合一致。
- 每个 namespace 的 key 深度一致，所有值为非空字符串。
- 默认 locale 为 `zh-CN`，仅接受 `zh-CN` / `en-US`。
- 缺失 key 能回退到中文。

### 偏好契约

- 无偏好、空值、非法值、旧值均返回 `zh-CN`。
- `en-US` 能保存并在重新初始化后恢复。
- localStorage 写失败不阻断当前会话语言切换。
- 切换后 `<html lang>` 与 i18next 当前语言一致。

### Formatter 契约

- 相同固定时间在 `zh-CN` 与 `en-US` 下产生各自格式。
- 数字和字节格式显式使用当前 locale。
- `0 / 1 / 2` 的英文复数正确，中文不出现英文复数后缀。

### UI 契约

- Settings 存在 General / Language 与两个选项。
- 切换语言后导航、当前页面、Tooltip 和 aria label 同步更新。
- 更新既有静态布局测试：断言稳定 translation key / 交互结构，不再断言源码中的英文句子。
- 增加 Renderer 用户可见硬编码审计。用 TypeScript AST 检查 JSX text 以及 `title`、`label`、`placeholder`、`aria-label` 等属性；品牌名和动态技术值使用小型显式 allowlist。

### 回归与视觉验证

- App 定向 i18n 测试、App 全量测试、Renderer TypeScript、App production build。
- Core 全量测试与 build，证明配置、扫描、生成和 DB 行为未被修改。
- `git diff --check`。
- 真实 Electron 窗口分别以 `zh-CN` / `en-US` 检查：
  - 900×620：主导航、Settings、Scan、Projects、Rules Overview。
  - 1280×800：Rules Generate Chat、弹窗、表格、空态和错误态。

## 实施步骤

每一步只交付一个可独立观察和验证的小改动；第一步先搭出“启动 → 读取默认语言 → 页面显示翻译 → Settings 切换 → 重启恢复”的端到端最小骨架。

| # | 独立改动 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|---|
| 1 | 搭建 i18next、locale 偏好与最小 General / Language 切换骨架，只迁移 App 主导航和 Settings 外壳 | 首次启动中文；切到英文立即更新主导航；重启保持英文；非法值回退中文 | locale/resource 单测 + Settings 切换测试 + Electron smoke | ✅ 完成 |
| 2 | 建立显式 locale formatter，迁移日期、数字、字节、数量与状态映射 | Scan/Rules 中日期和计数随语言变化；不再依赖系统隐式 locale | formatter 单测 + AST 检查隐式 locale API | ✅ 完成 |
| 3 | 迁移 Scan 页面全部用户可见文案 | Scan 最新结果、新建扫描、History、运行/取消/错误态均可完整切换 | Scan UI 契约 + 中英文真实窗口检查 | ✅ 完成 |
| 4 | 迁移 Projects 页面与共享组件全部用户可见文案 | 列表、详情、Session、Project Rules、空态和面包屑完整切换 | Projects UI 契约 + 中英文真实窗口检查 | ✅ 完成 |
| 5 | 迁移 Rules 页面全部用户可见文案 | 四个二级菜单、Generate Chat、Evidence、Review、Publish、History、弹窗完整切换 | Rules UI 契约 + 中英文真实窗口检查 | ✅ 完成 |
| 6 | 迁移 Providers / About 与剩余共享文案，加入硬编码审计 | Renderer 不再残留未经允许的用户可见硬编码文案 | AST 审计测试 + 资源 key/value 契约 | ✅ 完成 |
| 7 | 全量回归、最小/默认窗口视觉验收与上下文同步 | Core 行为和隐私边界无变化；两种语言无溢出和截断 | Core/App tests、build、TypeScript、Electron QA、`git diff --check`；追加 `memory/process.md` | ✅ 完成 |

## 完成记录（2026-07-30）

- 已完成 `zh-CN / en-US` 双语资源、默认中文、即时切换、持久化恢复、非法偏好回退和 `<html lang>` 同步。
- Scan、Projects、Rules、Settings、Providers、About 及生产可达共享界面已迁移；品牌、路径、slug、用户内容和动态技术诊断按范围保留原文。
- 日期、数字、字节、复数和状态统一通过显式 locale formatter / translation key 输出。
- AST 契约同时检查用户可见硬编码、隐式 locale API、资源 namespace/key 对齐和 Rules 语义 key 存在性。
- 真实 Electron 窗口验证中文默认、英文即时切换、重启恢复中文，以及 Scan / Rules / Settings 的双语布局；未发现页面级溢出。
- 最终自动化验收：App 10 suites / 62 tests、Core 24 suites / 237 tests、Core/App production build、Renderer TypeScript 与 `git diff --check` 全部通过。

## 风险与后续

- `RulesView.tsx` 约 3,500 行且文案密集，必须分批迁移，避免一次大改使现有交互契约失去定位能力。
- 现有测试大量断言英文源码字面量；迁移时应把它们改为稳定 key 或行为断言，而不是为了测试继续保留重复英文。
- Provider/Core 动态错误目前没有稳定 error code，一期只能本地化外层语义。完整错误本地化作为后续独立设计。
- 如果未来出现多窗口、Main 原生菜单、系统通知或 Main 创建的对话框，再把 locale 持久化迁移到 `app.getPath('userData')` 下的 app preferences，并通过 IPC 广播；一期不提前引入这套复杂度。
