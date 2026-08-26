# 大 Session 流式读取

## 范围与验收

- 为 `sessions show <session-id>` 增加 `--stream`，按 NDJSON 逐条输出 Session 原始记录。
- JSONL 来源不再整包读入内存，流式模式不受现有 50 MiB 一次性输出上限影响。
- 不带 `--stream` 的 JSON 输出、错误语义与 50 MiB 保护保持兼容。
- Copilot 与 OpenCode 复用相同的逐条输出契约；不改变各 Agent 的权威来源和读取方式。
- 下游通过 `head` 等命令提前关闭时，`EPIPE` 作为正常结束，不输出误导性错误。

## Step 1：固定流式输出契约

- 改动：先为 JSONL 大文件、记录顺序、BOM / CRLF、非法 JSON 和默认模式兼容增加测试；为 CLI `--stream` 参数增加契约测试。
- 观察点：流式输出每行都是独立 JSON，包含 `sessionId / agent / index / record`；默认模式仍输出原有单个 JSON 文档。
- 验证方式：运行 `sessions-show.test.ts` 与 `cli-options.test.ts`，确认新增测试在实现前按预期失败。

## Step 2：实现有背压的 NDJSON 输出

- 改动：JSONL 使用逐行读取；Copilot SQLite turns 使用迭代查询；OpenCode SDK 返回后逐条写出。所有写入统一处理背压和 `EPIPE`。
- 观察点：超过 50 MiB 的 fixture 可开始并完成流式输出，读取过程不构造完整 `records` 数组；管道提前关闭后命令正常退出。
- 验证方式：运行定向测试，并用构建后的 CLI 对临时大 JSONL 执行 `sessions show <id> --stream | head`。

## Step 3：回归与记录

- 改动：同步 `memory/process.md`，复核帮助文案和现有 Evidence 内部调用不受影响。
- 观察点：不带参数的调用继续被 Evidence 层捕获为单个 JSON 文档；App/Core 无回归。
- 验证方式：Core/App 全量测试、production build 与 `git diff --check`。
