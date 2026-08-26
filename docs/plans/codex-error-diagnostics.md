# Codex 严格 Schema 与结构化错误诊断

## 范围与验收

- Codex JSONL 中的结构化 error item 必须成为主错误，不能被 stderr 告警覆盖。
- stderr 诊断去重并限制长度，避免同一 Skills 扫描告警在项目和页面中无限重复。
- 找到结构化主错误后修复 Provider 兼容性，不删除任何 Skill 或缓存数据。
- 单项目真实 dry-run 成功后，再允许用户重新发起批量生成。

## Step 1：恢复真正错误

- 改动：解析 `item.completed/error` 与顶层 error event，退出码非零时优先展示结构化错误。
- 观察点：错误正文先出现 Codex 返回的主错误；重复 traversal diagnostics 只保留一份。
- 验证方式：LLM 单测构造 stdout error + 重复 stderr，先失败后通过。

## Step 2：修复严格 Structured Outputs Schema

- 改动：依据 Step 1 暴露的 400 修复 Schema：根节点包装为 object，候选字段全部 required，`project_slug` 使用 `string | null`。
- 观察点：Skills traversal 被确认是非致命 CLI 诊断；规则生成越过请求校验并进入 Evidence 分析，不移动或删除 Skill 缓存。
- 验证方式：运行 `rules generate --project rules-manager --dry-run`。

## Step 3：回归与记录

- 改动：同步 `memory/process.md`，保留错误诊断边界。
- 观察点：Chat 失败行短且可操作，生成链路无回归。
- 验证方式：Core / App 全量测试、production build、`git diff --check`。
