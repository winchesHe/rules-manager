# Rules Chat 停止与 Session Context 实时刷新

## 背景

原生 Rules Chat 已把最近 7 天扫描、Evidence 提取和 Provider 生成串成一条后台链路，但当前停止入口只会中断普通 Chat 的活跃 Provider Turn：

- 前置扫描和 Evidence 提取阶段没有登记为可中断的 Rules Run，点击 Composer 的停止按钮不会改变运行状态。
- Rules Evidence 写入 `sessionContext` 后虽然广播了 `chat.changed`，Renderer 仍通过“列表 + 历史 + 当前任务”整组异步刷新；并发读取时缺少最新请求门禁，当前页可能继续展示 revision 0，切页重载后才显示已选 Session。

## 改动范围

1. 为每个原生 Rules Run 建立独立 `AbortController`，贯穿前置扫描、Evidence 提取和规则生成。
2. 前置扫描支持等待方取消：本次 Rules Run 自己启动的扫描随 Run 停止；复用中的外部扫描只解除等待，不误停其他操作。
3. 停止时同时中断活跃 Provider Turn；取消路径写入 `interrupted / cancelled`，不追加“规则生成失败”。
4. Renderer 对当前任务的 `chat.changed` 直接重读 `chat.read`，并以单调请求序号保证旧响应不能覆盖新 Session Context revision；任务列表仍独立刷新。
5. Context 查询在当前任务切换或 revision 变化时重新读取，保证已选态和当前任务的排除项同步。

## 观察点与验收标准

### 停止链路

- 在 changed7d 前置扫描尚未完成时点击停止：扫描被取消，Rules Chat 最终为 `interrupted`，run metadata 为 `cancelled`。
- 在 Provider 已开始生成时点击停止：Provider adapter 收到 interrupt，Run 不再继续生成或落候选。
- 重复点击或停止已结束任务不抛出未处理错误。

### Context 实时刷新

- 新建 Rules Chat 后保持在当前页面；Evidence 完成时 Context badge 和已选 Session 自动从 0 更新，无需切换页面。
- 多个 `chat.changed` / 初始加载并发时，旧的 `chat.read` 响应不能覆盖更新后的 revision。
- 切换任务后 Context 可选列表使用当前 chatId 重新查询。

### 验证方式

- Scan Controller 单元测试：自有扫描随 AbortSignal 取消；复用扫描仅解除等待。
- Native Chat Controller 单元测试：Rules Run 停止覆盖前置阶段并写入中断状态。
- Renderer 纯逻辑 / 合同测试：最新读取门禁、当前任务变更触发 Context 重载。
- App 与 Core 全量测试、production build、`git diff --check`。
- 真实 Electron：启动 changed7d Rules Chat，保持当前页观察 Context 自动出现，再点击停止确认状态结束。

