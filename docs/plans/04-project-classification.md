# Plan 04: Project Classification

> ⚠ **Superseded by `docs/specs/scan-classify-fs-rewrite.md`**（2026-05-17）。
> 本 plan 的 projects / session_projects / project_hints 三表设计 + confidence 概念全部被 FS-first 重构砍掉；
> 分类结果改为 `<workspace>/projects/<slug>/<sid>.jsonl` symlink，DB 只剩 `sessions.slug` 一列。

## 目标

把 adapter 提供的 `ProjectHint` 聚合成稳定项目归类，并确保 `test/sources` 的合成 fixture 能按预期分类。

## 最小可验证链路

输入：

```text
test/sources/
  claude/
  codex/
  copilot/
  cursor/
```

预期输出：

| agent | expected project |
| --- | --- |
| `claude` | `Atlas_Desktop` |
| `codex` | `orbit-cli` |
| `copilot` | `memory-lab` |
| `cursor` | `sample-browser-extension` |

## 分类规则

评分优先级：

```text
git_root > cwd > source_project_path > message_path > branch
```

建议基础分：

```text
git_root: 0.95
cwd: 0.90
source_project_path: 0.85
message_path: 0.65
branch: 0.20
```

`branch` 只做辅助，不单独决定项目。

## unknown 策略

无法可靠归类时使用：

```text
unknown
```

约束：

1. `unknown` 不参与正式项目 rules。
2. `unknown` 可以参与 global/personal-style 候选，但降权。
3. 后续可通过人工命令修正。

## DB 写入

至少保存：

```text
projects
session_projects
project_hints
```

`project_hints.value` 只能保存路径、repo、branch 等轻量信息，不保存完整对话 content。

## 验收

运行：

```bash
memory-manager scan --source test/sources --all
memory-manager projects list
```

必须看到：

```text
Atlas_Desktop
orbit-cli
memory-lab
sample-browser-extension
```

且 confidence 建议不低于：

```text
0.80
```

测试不要求真实项目目录存在，可以基于 source 字符串和内容分类。

## 渐进增强

后续增强：

1. `projects assign <session-id> <project-key>`。
2. `projects merge <from> <to>`。
3. `projects reclassify --full`。
4. 冲突 hint 的 review 队列。

## 非目标

本阶段不做：

1. rules generation。
2. confidence system。
3. Markdown 输出。
