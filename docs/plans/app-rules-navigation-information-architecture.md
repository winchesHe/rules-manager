# Rules 导航信息架构落地

## 范围

- 将 `docs/prototypes/rules-navigation-information-architecture.html` 已确认的 Rules 二级导航落入真实 App。
- Rules 导航分为两组：
  - `规则管理`：`概览 / 规则工作台`
  - `Agent 上下文`：`Agent 指令 / Agent Memory`
- 将原导航文案 `生成的规则` 改为 `规则工作台`；内部 `RulesSection` id、页面路由和业务行为保持不变。
- 二级按钮使用与父级导航相同的整行热区，内部 padding 负责文字对齐。
- 两处分组边界使用同一 16px 视觉节奏，不展示竖线或 active 短标。

## 不在本轮

- 不把 HTML 原型中的候选数、Agent 数、Memory 数等演示数据写入真实导航。
- 不重构 Rules 主内容、生成流程、审核流程、发布协议、Agent Memory 或 IPC。
- 不修改 `RulesSection` 的 `overview / generated / agents / memories` 稳定标识。

## 观察点

1. 进入 Rules 后，侧栏顺序为 `概览 / 规则工作台 / Agent 指令 / Agent Memory`。
2. `规则管理` 与 `Agent 上下文` 分组标题可见，两处分组边界间距一致。
3. 二级按钮左右边界与父级按钮一致；文字与父级「规则」文字基本对齐。
4. hover、active、press 与键盘 focus 的热区覆盖整行，不存在左侧死区。
5. 再次点击父级 Rules 仍回到概览；项目发布与 Chat 候选入口仍进入 `generated` section。
6. 中文与英文 locale key 保持一致，窄窗口不出现导航文字裁切或页面级横向溢出。

## 验证方式

- 更新 `home-workflow-layout.test.ts`，锁定分组、顺序、文案 key、整行热区和去除竖线的契约。
- 运行 App 定向测试与 App 全量测试。
- 运行 App production build；如 typecheck 仍受既有 workspace 配置阻断，记录边界并确认本轮文件没有新增错误。
- 在真实 Electron 中检查深色、浅色、默认宽度和窄窗口；点击四个二级入口并回点父级 Rules。
- `git diff --check` 检查本轮文件。
