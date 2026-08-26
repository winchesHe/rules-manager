# Rules 生成在 Session Context 就绪后进入 Chat

## 背景

Rules 页面点击“继续进入对话”后，原生 Rules Run 会先执行 changed7d 扫描，再提取 Evidence 并写入
`sessionContext`。此前启动 IPC 在任务创建后立即返回，Renderer 因而可能先进入 Context 为空的 Chat，随后再靠
`chat.changed` 补齐。即使最终数据一致，用户仍会看到错误的交互顺序。

## 目标交互

1. 用户在 Rules 生成配置页点击生成。
2. 页面保持不跳转，锁定本次配置并显示“扫描 Session / 准备 Session Context”的 loading。
3. changed7d 完成扫描，规则 Evidence 完成提取，相关 Session 引用写入新任务。
4. 启动 IPC 返回，页面自动进入该 Chat；第一帧读取到的 Context 已经是最终选中集合。
5. Provider 规则生成继续在 Chat 中运行，既有停止能力不变。

## 改动范围

- `NativeChatController.startRulesGeneration` 改为异步就绪合同：任务仍立即创建并在后台运行，但只有
  `onEvidence` 完成 Context 持久化后才 resolve。
- 扫描、Evidence 或 Context 写入在就绪前失败时 reject 启动请求；Rules 页面不跳转并展示现有错误提示。
- Rules 生成配置页增加明确的 Context 准备状态、自动进入说明和 `aria-live`，开始后继续禁用范围及 Provider
  配置。
- 不重复扫描、不重复提取 Evidence，不把 Session 正文放进 IPC 返回值；Chat 继续从持久化任务读取引用。

## 观察点与验收标准

- changed7d 扫描未完成时，启动 Promise 未 resolve，页面仍停留在 Rules 配置页。
- Evidence 回调写入 Context 后，启动 Promise resolve；读取对应 Thread 时 revision 和 selected refs 已就绪。
- Renderer 只在启动 Promise resolve 后调用 `onStarted`，进入 Chat 首屏即显示非零 Context，无需等待
  `chat.changed` 或切页。
- 准备失败不进入 Chat，错误可见；后台任务状态与 run metadata 保持原有失败语义。
- App / Core 全量测试、production build、`git diff --check` 通过；真实 Electron 验证 loading → 自动跳转 →
  首帧 Context，并停止测试 Run。

