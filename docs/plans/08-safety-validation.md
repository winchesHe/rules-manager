# Plan 08: Safety & Validation

## 目标

补齐安全、隐私、dry-run、mock LLM 和端到端验收，确保 MVP 可控、可调试、可验证。

## 安全原则

默认策略：

1. DB 不存完整 content。
2. LLM 前做 secret redaction。
3. LLM prompt/response 不默认落盘。
4. `--debug` 不默认打印完整 session。
5. 支持 `--dry-run`。
6. 测试默认使用 mock LLM。

## Secret Redaction

LLM 输入前必须脱敏：

```text
API key
Authorization header
token
cookie
private key
password
.env value
```

脱敏只作用于 LLM 输入，不修改源文件，不写回 DB。

## LLM Run Metadata

DB 只记录元信息：

```text
llm_runs
  id
  task
  mode
  model
  effort
  input_hash
  output_hash
  status
  error_message
  token_usage
  created_at
```

不默认保存完整 prompt/response。

## Dry-run

支持：

```bash
memory-manager scan --dry-run
memory-manager rules generate --dry-run
```

行为：

1. 不更新 DB。
2. 不写 Markdown 文件。
3. 展示将处理的 source、session、项目和 rules 生成计划。

## Mock LLM

测试默认使用 mock LLM。

必须覆盖：

1. schema valid。
2. invalid JSON retry。
3. 无 evidence candidate rejected。
4. render_markdown 不新增 rule。
5. redaction 在 LLM 输入前生效。

## 端到端验收

完整 MVP 验收命令：

```bash
memory-manager init --non-interactive
memory-manager scan --source test/sources --all
memory-manager projects list
memory-manager rules generate --dry-run
memory-manager rules generate
memory-manager rules output --project Atlas_Desktop
memory-manager rules output --global
memory-manager rules output --style
```

必须证明：

1. 4 个真实 source 被发现。
2. 4 个 agent 分类准确。
3. DB 不保存完整 session content。
4. rules 生成经过 `pi-code-agent` SDK。
5. 正式 Markdown 只包含 `high` 和 `verified`。
6. P0-P6 只用于最终 Markdown 文案优化。

## 渐进增强

后续增强：

1. `errors list` 和 `errors inspect`。
2. `--debug-llm --debug-output <path>` 显式保存 prompt/response。
3. 更严格的 secret pattern。
4. CI 中运行 fixture 分类测试。

## 非目标

MVP 不默认：

1. 持久化完整 LLM prompt/response。
2. 打印完整 session。
3. 上传 session content。
