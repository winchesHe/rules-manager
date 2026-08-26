# APP 开发环境热更新修复

## 范围与验收标准

- Renderer 源码修改继续通过 Vite HMR 更新当前窗口，不重启 Electron。
- Main 源码修改触发重新构建并重启 Electron；Preload 保持 electron-vite 默认监听行为。
- 后台 Worker 继续按现有多入口方式独立构建，生产路径、workerData 与消息协议不变。
- Renderer dev 端口固定为 5173；端口已占用时第二次启动明确失败，不再静默漂移到未被当前窗口使用的 5174。
- 不修改 Core、DB、Chat 数据或生产业务行为，不碰现有 Chat HTML 原型改动。

## 已复现观察

- 5173 的 HMR WebSocket 在触碰 `renderer/src/styles.css` 后收到 `/src/styles.css` 的 `js-update`，
  Renderer 更新链正常。
- 修改 `main/index.ts` 后，`out/main/index.js` 时间戳与 Electron PID 均不变化，Main watch 失效。
- electron-vite 5 的 `dev` 命令默认不监听 Main/Preload；CLI 只有收到 `--watch` 时才向两端注入
  `build.watch`。项目原 `dev` script 没有该参数。
- 已有 dev 占用 5173 时再次启动，会输出“trying another one”、启动 5174，随后 Electron 因单实例锁
  正常退出，命令仍以 0 结束。

## 实施与验证

| # | 独立改动 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|---|
| 1 | 锁定 `--watch` 与 strictPort 契约 | 旧配置不满足新契约 | 新增配置契约测试并先确认失败 | ✅ 完成 |
| 2 | dev script 加入 `--watch`，保持 Worker 构建不变 | Main/Preload watcher 启用；Worker 输出路径不变 | 定向测试 + production build | ✅ 完成 |
| 3 | Renderer dev server 启用 strictPort | 第二次 dev 启动明确失败，不产生 5174 | 双启动 smoke | ✅ 完成 |
| 4 | 真实 HMR 与回归收口 | Renderer 收到 update；Main 重建且 PID 变化 | HMR WebSocket、Main marker、App 全量测试/build、diff check | ✅ 完成 |

## 完成记录

- `packages/app/package.json` 的 dev script 改为 `electron-vite dev --watch`，Main 和 Preload 进入
  electron-vite watcher；现有 Worker 多入口和生产输出保持不变。
- Renderer dev server 固定 5173 且启用 `strictPort`，已有实例运行时第二次启动以 code 1 明确失败，
  不再创建无人使用的 5174 server。
- 真实 smoke：Renderer HMR WebSocket 收到 CSS `js-update`；Main marker 修改后 Electron PID 从
  `84378` 变为 `84703`，回退 marker 后再次变为 `84809`；临时 marker 已清理。
- 回归结果：配置定向 2/2、App 22 suites / 135 tests、production build 与 `git diff --check` 通过。
