# Chat Live Evidence · OpenCode 可靠性修复

## 背景

真实 Chat 选择 242 个 Session 后，OpenCode `promptAsync + json_schema` 命中上游
`OutputFormatJsonSchema` 编码缺陷。Map 将每个失败当作独立 Session 失败继续执行，导致任务长时间停留在
Loading；中断后 Thread 总状态虽为 `interrupted`，`nativeState` 仍残留 `starting`。

## 范围与设计

1. OpenCode 结构化请求改走同步 `session.prompt`，将 JSON Schema 作为严格 JSON 指令注入并由本地 Zod 校验，
   不再发送上游 `format`；普通 Chat 继续使用 `promptAsync + SSE`，保留流式输出、Tool 与交互能力。Map capsule
   的 Session、Agent、Chunk 与 source revision 属于 Host 已知身份，由 Host 在 Zod 校验后覆盖模型输出。Evidence
   Map chunk 上限独立收紧到 64 KiB（不受较大的 Reduce 批次预算放宽），超大单条消息也按 UTF-8 边界
   切分，避免模型上下文溢出。
2. Map 对相同失败签名连续累计 3 次后打开熔断器，停止分配新 job、调用 Runner interrupt 取消仍在运行的
   Provider job，并向可见 Chat 返回可操作错误；不同 Session 的零散内容失败仍按 partial Coverage 处理。
3. `targeted` 模式仍由 Host 权威读取全部 selection 并保留 Coverage，但只把本地词项命中的 Session 送入
   Map；单个命中 Session 继续按本地词项选择最多 4 个相关 chunk。其余 readable Session 标记为
   `not_required`。`complete` 模式不得裁剪 Session 或 chunk。
4. Evidence 进度在阶段变化、每 10 条和阶段完成时持久化到 Thread；Renderer 优先显示实时事件，事件缺失或
   页面重载时回退到持久化进度。完成、失败和中断清理活动进度。
5. 无原生 Session 的失败和中断分别落为 `start-failed` / `interrupted`；重新发送时恢复 `starting`。
6. 单次结构化 Map / Reduce 调用超过 120 秒时由 Host 主动 interrupt，并返回可审计的超时错误，避免
   Provider 悬挂重新制造无限 Loading。

## 观察点与验证方式

| 观察点 | 验证方式 |
|---|---|
| 结构化 OpenCode 不调用 `promptAsync`、不发送 `format`，能读取同步 JSON 响应 | Adapter 单元测试覆盖 structured / ordinary 两条路径 |
| 模型写错 capsule 身份时不会误判 Session | Runner 单元测试断言 Host 覆盖 capsule 与 locator 身份 |
| 超大单条消息不会形成超预算 chunk | Context 单元测试断言每个 UTF-8 分片字节数不超过预算 |
| 三次同签名 Map 错误后不再遍历全部 selection | Engine 单元测试断言调用上限、interrupt 和熔断错误 |
| 不同签名错误仍生成 partial Coverage | 保留并扩展多 Session 失败测试 |
| targeted 只 Map 本地命中，Ledger 对其余项记 `not_required` | Planner / Engine 单元测试覆盖命中与 complete 不裁剪 |
| targeted 超大 Session 不遍历所有 chunk | Engine 单元测试断言 64 KiB 分片且最多 Map 4 个相关 chunk |
| Provider 调用悬挂不会无限 Loading | Runner 单元测试使用短超时断言 interrupt、超时错误与 close |
| 重载期间仍能看到阶段与计数 | Controller / Store / Renderer 合同测试 |
| 中断后不残留 `nativeState=starting`，重试可重新进入 starting | Store 与 Controller 单元测试 |
| 没有无限 Loading 回归 | 真实 Electron 使用 OpenCode + 多 Session Context 验证进度、完成或快速失败、停止 |
| 全局行为无回归 | App/Core 全量测试、production build、`git diff --check` |

## 验收门禁

- 不降低 complete 模式的 selected / visited / readable / processed 口径。
- 不把 `targeted` 声称为完整覆盖；未进入模型的 readable Session 必须可审计为 `not_required`。
- 熔断错误必须保留原始失败签名，不得只显示泛化的“生成失败”。
- 中断必须同时停止剩余 Evidence job，并使 Thread 进入稳定终态。
