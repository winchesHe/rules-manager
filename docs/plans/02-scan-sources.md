# Plan 02: Scan & Sources

## 目标

实现扫描入口，让用户可以选择内置 agent 或 custom path，并将扫描结果写入轻量 DB 状态。

## 最小可验证链路

实现命令：

```bash
memory-manager scan --source test/sources --all
memory-manager scan --agent claude,codex
memory-manager scan --agent custom --path /path/to/source
memory-manager scan --full
```

交互模式：

```bash
memory-manager scan
```

可选 source：

```text
claude
codex
copilot
cursor
custom path
```

## Scan 状态

每个 session 必须分类为：

| 状态 | 条件 |
| --- | --- |
| `new` | `session_id` 不存在 |
| `updated` | `updated_at` 变化 |
| `updated` | `content_hash` 变化 |
| `unchanged` | `updated_at` 和 `content_hash` 都不变 |
| `missing` | 源文件消失，默认保留索引 |
| `error` | 解析或归一化失败 |

## Custom Path

custom path 流程：

1. 检查路径是否存在。
2. 运行各 adapter 的 `probe`。
3. 判断是否包含可识别 session。
4. 用户确认 adapter。
5. 保存到 `config.toml`。

## 最小 DB 写入

scan 后至少写入：

```text
session id
agent
source path
source kind
updated_at
content_hash
scan_state
first_seen_at
last_seen_at
```

不写入完整 session content。

## 验收

第一次运行：

```bash
memory-manager scan --source test/sources --all
```

期望：

```text
Sessions: 4+ total
New: 4+
Errors: 0
```

第二次运行：

```bash
memory-manager scan --source test/sources --all
```

期望大部分为：

```text
unchanged
```

## 渐进增强

后续增强：

1. `scan --dry-run` 不写 DB。
2. `scan --verbose` 展示 probe 和 discover 详情。
3. source 权限错误分级。
4. `sessions prune --missing` 清理 missing session。

## 非目标

本阶段不做：

1. 高质量 project classifier。
2. rules generation。
3. LLM 调用。

