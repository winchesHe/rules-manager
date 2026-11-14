# Grok Build 与 Gemini CLI Session 适配器

## 目标

让 memory-manager 在扫描后可通过 Query、Session 详情与实时上下文读取本机 Grok Build CLI 和 Gemini CLI 会话。

## 范围

- Grok Build：读取 `${GROK_HOME:-~/.grok}/sessions/<cwd>/<session-id>/` 下的 `summary.json`、权威 `updates.jsonl`；仅在更新流无对话内容时回退到 `chat_history.jsonl`。
- Gemini CLI：读取 `${GEMINI_CLI_HOME:-$HOME}/.gemini/tmp/<project-hash>/chats/session-*.jsonl`，重建追加记录、消息 patch、删除、排序及 rewind 后的当前会话。
- 注册 `grok`、`gemini` Agent，并让扫描、Query v2、Session Show、证据读取和 live Context Reader 使用同一来源语义。
- 不改数据库 schema，不读取网页产品的云端聊天历史，不写入或改动源会话。

## 观察点与验证方式

| 观察点 | 验收 | 验证方式 |
| --- | --- | --- |
| 扫描可发现标准路径中的两个 Agent 会话，并提取可信会话 ID、时间与路径元数据 | 指定扫描和 `scan --all` 注册表包含新 Agent；隔离 fixture 可分类 | adapter discovery/parse 定向测试与隔离 CLI scan |
| Query 读取当前有效对话，而非 Gemini 已 rewind/patch 前的陈旧消息；Grok 忽略 system/thought 和未知扩展事件 | user/assistant 消息、工具调用与结果可读；新 Agent 可进入 Query v2 `scope.agents` | Session Event Reader、Query schema 定向测试 |
| live Context 与 Session Show 回源到权威本地文件 | prepare proof 可通过 locate/read 回源；源文件变化可体现在 revision | Session Source Reader 与 Context 集成定向测试 |
| 正常扫描不把正文写入 memory-manager DB | DB 仅保存已有元数据与 hash | 隔离 CLI scan 后查表结构/行字段 |
| 本机是否有可用于真实行为验收的两种 Agent 数据 | 有真实目录时只在隔离 workspace 只读扫描；没有则披露限制 | 只检查目录存在性与 fixture 行为，不读取用户会话正文 |

## 实施顺序

1. 增加 Gemini / Grok adapter 和标准目录解析。
2. 接入 Query、Session Show、证据与 live Context 的来源解析，并同步可见 Agent 列表及本仓库 skill 合同。
3. 用隔离 fixture 验证 scan → Query → live read，构建 Core；若没有真实源目录，不宣称真实会话验收通过。

## 已知限制

- Gemini CLI 的项目 hash 不能还原启动目录；仅在 Session 本身带可信绝对路径时提供项目 hint，否则由现有分类逻辑落到 default。
- 本机目前没有 `~/.gemini/tmp` 或 `~/.grok/sessions`，真实历史查询需等对应 CLI 在本机保存会话后验证。
