# Chat View 原生 Session 重构实施计划

权威产品与协议规格：
[docs/specs/chat-view-native-sessions.md](../specs/chat-view-native-sessions.md)。每一步只完成一个
可独立验收的增量；完成后立即跑定向测试并记录结果，不把多个 Provider、Context Pane 和
Rules 迁移攒到最后。

## 基线（2026-08-01 实测）

- Core：25 suites / 275 tests，skipped=0。
- App：14 suites / 97 tests，skipped=0。
- Core/App production build 均通过；Core 只有既有 `tsdown define` warning。
- Claude Code 2.1.220，`@anthropic-ai/claude-agent-sdk` 0.3.220；Codex CLI 0.146.0。
- 当前 Codex Rules Generation 使用 `exec --ephemeral --sandbox read-only`；当前 Chat 无
  Composer，`ChatStore` 只接受 `kind=rules-generation` version 1。

## 1. Claude Native Chat 端到端最小骨架

只打通 Draft → 首次发送 → Claude Native Session → 可见回复 → 同 Session 第二轮 → 重启
恢复。新增通用 Chat v2 类型、兼容读 version 1、`ChatRuntimeManager`/Provider Adapter
边界、最小 IPC 和中央 Composer；暂不实现右侧 Session Context、Archive 和 Rules 迁移。

观察点：

- 空 Draft 不出现在左栏；首次发送后出现 Chat，`thread.json` 保存 Claude
  `nativeSessionId`，Provider 被锁定。
- 第二轮继续相同 Native Session；重启 App 后再次发送仍保持相同 ID。
- working directory 固定为 workspace，Full access 可见；不同 Chat 可同时运行。

验证方式：

- 先写 ChatStore v2 兼容、RuntimeManager 单 Chat 串行/跨 Chat 并行、Claude SDK 参数和
  IPC/Renderer 契约红测；不 mock 被测 RuntimeManager。
- 使用临时 HOME 的假 SDK stream 验证 session ID、resume、消息投影和中断。
- 在本机可用 Claude 上执行两轮 smoke，并重启后执行第三轮；记录前后三轮 session ID。

## 2. Codex app-server Provider Adapter

只补 Codex Native Session，与第 1 步共用 Runtime/Store/IPC，不改右侧 Context 和 Rules。

观察点：

- `thread/start` 获取并保存 thread ID；第二轮和重启后使用 `thread/resume`。
- `turn/start` 正确传 model/effort/serviceTier、固定 cwd、danger-full-access 和 never。
- interrupt 只停止当前 turn，不删除 Chat；token usage 更新 Context Window。

验证方式：

- 使用可控 JSON-RPC 假进程覆盖 initialize、start/resume、delta、tool、usage、interrupt 和
  进程异常；断言 Chat 路径不再调用 `codex exec --ephemeral`。
- 本机 Codex 三轮 smoke 对账同一 thread ID。

## 3. Paseo 式 Conversation 与 Composer 控件

只完善中央区：Provider/model/effort/fast、Skill 插入、Context Window、流式 Message 和
Tool 卡片；不实现 Session Context 选择。

观察点：

- 首轮后 Provider 锁定，其余参数下一轮生效；每条消息显示实际 turn config。
- Tool 默认显示预览，展开时按 Native Item ID 懒加载；大输出不会整份进入 Renderer。
- `/skill-name` 只出现在当前消息；usage 缺失显示 `—`。

验证方式：

- View model、IPC 边界和 Provider event normalizer 测试覆盖缺失能力、大输出和隐藏 Prompt
  过滤；真实窗口验证滚动跟随、停止和窄屏。

## 4. Session Context 查询、选择与注入

只实现右侧 Pane、分页查询和 version 1 注入协议，不迁 Rules。

观察点：

- Project/all/default、日期范围、7/30 天和虚拟列表可组合；切换筛选不丢已选集合。
- 首次选择或变化后的下一轮包含完整 `selected`、净 `added/removed` 和逐条 `--stream`
  命令；无变化不重复注入，清空产生空 replace。
- App 不读取 Session 原文、不显示“已加载 N/M”，单源失效不阻塞 turn。

验证方式：

- Core 查询测试覆盖排序、边界日期、default/all、分页稳定性和 missing。
- Prompt snapshot 与 Adapter 测试覆盖首次、无变化、增删、清空、失败重试及隐藏内容不落盘。
- 真实选择一个大 Session 和一个失效 Session，确认 Agent 尝试两者并继续回答。

## 5. History 生命周期

只实现重命名、Archive/Restore、永久删除和 resume failure，不迁 Rules。

观察点：

- Active/Archived 与折叠 Rail 符合 Paseo；运行中 Archive 需确认并先 interrupt。
- Codex 同步原生 archive/unarchive；Claude 只切本地状态。
- 永久删除严格先删 Native，再删 ChatStore；失败保留可重试记录。
- resume failure 不改 native ID，可显式复制配置和 Context 创建新 Chat。

验证方式：

- 两 Provider 生命周期契约、not-found 幂等、部分失败和进程重启测试；真实窗口验证二次确认。

## 6. Rules Run 迁入普通 Chat

只迁 Rules Start Generate 和 Candidate Artifact；不重做审核/发布页面。

观察点：

- Start Generate 自动进入 Chat 并提交首轮；Native Session ID 可恢复。
- 只有 `rules-generation` turn 使用 structured output 并产生 Candidate；后续普通对话不会。
- 当前 Evidence 资格、project/global 纠正、low 过滤和 Candidate 事务语义全部保留。

验证方式：

- 复用现有 Rules 质量测试并新增 Rules → Chat → Artifact → Generated Rules 端到端测试。
- 真实 Claude/Codex 各跑一次项目生成，重启后仍能继续普通对话。

## 7. 响应式、兼容与全量收口

观察点：

- version 1 Rules Thread 仍可只读；无 Native Session 时不显示可继续输入的假 Composer。
- 三栏各自滚动；窄屏 Context/Rail 转 Sheet，页面无横向滚动。
- 归档、缺失源、Provider 离线、恢复失败和空状态都有明确 UI。

验证方式：

- `npm test -w @memory-manager/core -- --runInBand`
- `npm test -w @memory-manager/app -- --runInBand`
- `npm run build -w @memory-manager/core`
- `npm run build -w @memory-manager/app`
- `git diff --check`
- 1024×768、1440×900、1920×1080 真实 Electron 验收；最终同步 `memory/process.md`。

