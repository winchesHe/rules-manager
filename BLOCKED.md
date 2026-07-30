# 阻塞项

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
