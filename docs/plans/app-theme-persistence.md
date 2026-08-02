# APP 主题配色与持久化

## 范围与验收标准

- 暗黑模式使用白黑中性色：黑色背景、白色前景与白色主操作，不再使用品牌绿作为强调色。
- 明亮模式使用白蓝配色：白色 Surface、浅蓝背景与蓝色主操作。
- 主题切换立即生效，并保存为本机 Renderer 偏好；完全退出并重启 APP 后恢复上次选择。
- 偏好缺失、损坏、存储不可读时安全回退暗黑模式；存储写入失败不阻断当前会话切换。
- 主题在 React 挂载前恢复，避免启动时先显示错误主题。
- 不修改 Core、DB schema、workspace 配置、Chat 数据或业务状态机。

## 观察点与验证方式

| # | 独立改动 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|---|
| 1 | 锁定主题偏好读取、保存与 DOM 应用契约 | 当前主题仅在 React state 中，重启固定回到 dark | 新增主题单元测试，先覆盖合法/非法值、读写异常和 class 切换 | ✅ 完成 |
| 2 | 接入启动恢复与切换保存 | `createRoot` 前恢复主题；切换写入 `memory-manager.theme` | 源码契约测试 + App 定向测试 | ✅ 完成 |
| 3 | 更新暗黑白黑、明亮白蓝 token 与设计规范 | dark 主色为白、light 主色为蓝，两套背景与前景符合语义 | CSS token 契约测试 + production build | ✅ 完成 |
| 4 | 全量回归与上下文同步 | Renderer/Core 行为无回归，记录实现结论 | App/Core 全量测试、两端 build、`git diff --check`、同步 `memory/process.md` | ✅ 完成 |

## 设计决策

- 偏好保存在 Renderer `localStorage`：`memory-manager.theme = dark | light`。主题只影响单机 UI，
  不需要 Main、Worker 或 Core 消费。
- 默认值继续遵循 `DESIGN.md` 使用 dark；非法值不猜测系统主题。
- 启动入口同步读取并应用 `<html>` class，React 组件使用同一读取函数初始化状态。
- `success / danger / warning` 保留状态语义色；本轮“白黑 / 白蓝”约束作用于背景、前景、主色、
  柔和主色、边框与默认 Surface，不以蓝色或白色替代错误/成功语义。

## 完成记录

- 新增独立主题偏好模块，统一校验、读取、写入、DOM class 应用和启动初始化；偏好 key 为
  `memory-manager.theme`。
- `main.tsx` 在 React 挂载前恢复主题，`App.tsx` 使用同一存储值初始化并在切换时立即持久化。
- dark token 已收敛为白黑灰阶，light token 已收敛为白底蓝色主操作；状态语义色保持独立。
- 自动验证：主题定向 6/6、App 21 suites / 133 tests、Core 26 suites / 277 tests 全绿；
  App/Core production build 与 `git diff --check` 通过。
- App 独立 typecheck 仍命中既有跨 workspace `rootDir/TS6307`、JSON include 与 `RulesView`
  类型债；本轮新增模块由 ts-jest 编译通过，完整 Renderer 已由 production build 验证。
