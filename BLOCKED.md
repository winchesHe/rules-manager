# 阻塞项

## OpenCode / Pi 原生 Provider（2026-08-06）

- 非阻塞环境偏差：目标文件记录 OpenCode 版本 `1.4.6`，任务 0 复测为 `1.17.11`；可执行文件仍为
  `/opt/homebrew/bin/opencode`。后续以当前真实版本做兼容与 smoke，不把旧版本号当验收前提。
- 已补齐原覆盖缺口：使用仓库外临时 Pi extension 注册真实交互 Tool，Pi 0.79.3 已实际发出
  `extension_ui_request`，Adapter 回答 A 后同一 turn 完成并返回 `PI-QUESTION-A`；临时扩展未进入项目或用户配置。
- 非阻塞瞬态：一次 OpenCode 真实能力请求返回 `unknown certificate verification error`，相同命令随后重试成功；
  未禁用 TLS 校验，也未对实现增加不安全回退。
- 当前无阻塞项。

## Chat V1 原生 Session 重构（2026-08-01）

无。

## Generation Run Paseo UI（2026-07-29）

- 功能、测试、构建与 diff check 均无阻塞。
- 未自动创建 commit：任务开始前仓库已处于旧根目录大量删除、`packages/` 与本任务多数白名单文件整体未跟踪的迁移状态；直接 stage/commit 会把用户既有改动一并纳入，违反“不得覆盖/接管用户现有改动”。本任务改动保留在工作树中。

## Settings 独立全屏视图（2026-07-29）

无。

## HeroUIProvider

- 任务要求 `main.tsx` 使用 `HeroUIProvider`，但白名单内已安装的 `@heroui/react@3.2.2` 不导出该组件。
- 该 Provider 属于 HeroUI v2 API；v3 通过 `@heroui/react/styles`、根 `.dark/.light` 和 CSS token 原生驱动组件主题。
- 受白名单限制不能修改依赖版本，且不应伪造同名 Provider；因此跳过 Provider 包裹，继续完成 v3 原生主题集成验收。

## Core package exports

- `@memory-manager/core` 根导出中 `runScan` / `loadLlmConfig` 均为 undefined，`@memory-manager/core/scanner` 与 `@memory-manager/core/config` 均返回 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- 修复应扩展 `packages/core/package.json` exports，但该文件不在本次白名单。`core/dist` 不是可用替代：标准 core build 只生成 `dist/cli.js`。
- app main 因此暂时静态导入 core source，由 electron-vite 正常内联；`npm run typecheck` 的 composite/rootDir 约束会报 `TS6059/TS6307`。使用同一 tsconfig 加 `--composite false --rootDir ../..` 的完整检查通过，说明其余类型无误。

## Rules Output 返回契约

- `runRulesOutput({ all: true })` 同步写文件但返回 `void`；本任务要求 IPC 返回路径，同时白名单禁止修改 `rules-output.ts`。
- main 只能在同步调用期间捕获并继续转发既有“已写入/未变化”日志，从中提取路径。该方案不会跨 await 覆盖 console，但依赖现有中文日志格式；后续应让 core 直接返回结构化路径列表。
