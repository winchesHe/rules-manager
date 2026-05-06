# Plan 01: Workspace & State

## 目标

建立 `memory-manager` 的最小本地状态基础，让后续 scan、adapter、rules generation 都有稳定落点。

## 最小可验证链路

实现：

1. `memory-manager init --yes`
2. 创建 `~/.memory-manager/`
3. 创建 `~/.memory-manager/rules/projects/`
4. 创建 `~/.memory-manager/memory.db`
5. 支持 `memory-manager status`

验收：

```bash
memory-manager init --yes
memory-manager status
```

期望看到：

```text
Home: ~/.memory-manager
Database: ready
Rules dir: ready
Configured agents: auto-detect
```

## 数据范围

DB 只存内部状态，不存完整 content。

允许保存：

```text
session id
agent
source path
updated_at
content_hash
project_key
project hints
rule candidates
confidence
user feedback
evidence pointer
run metadata
```

禁止保存：

```text
完整 user message
完整 assistant message
完整 tool output
完整 session dump
完整 LLM prompt/response
```

## config.toml

初始可以不创建复杂配置。只有用户保存 custom source 或 LLM 参数时才创建。

最小 LLM 配置：

```toml
[llm]
mode = "openai-response"
model = "gpt-5.4"
effort = "high"
```

custom source 配置：

```toml
[[custom_sources]]
name = "my-claude-source"
agent = "claude"
path = "/path/to/sessions"
enabled = true
```

## 渐进增强

后续增强：

1. `init --force` 重新初始化。
2. `status --verbose` 展示 DB 表状态。
3. 配置文件 schema 校验。
4. 配置迁移版本号。

## 非目标

本阶段不做：

1. agent scan。
2. rules generation。
3. LLM 调用。
4. logs/cache/snapshots 目录。

