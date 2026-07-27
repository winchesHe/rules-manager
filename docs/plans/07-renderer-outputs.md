# Plan 07: Renderer & Outputs

## 目标

把 `high` 和 `verified` rules 渲染成最终 Markdown 文件。

## 与全局来源管理的边界

已落地的 `rules show <agent>` 用于只读查看 agent live 全局 instruction source，不代表本 Plan 的生成产物，也不允许 renderer 直接覆盖这些 live 文件。渲染产物继续写入 `~/.memory-manager/rules/`，未来安装到 agent 全局来源必须另写含备份、冲突检测和 compare-and-swap 的 spec。

## 输出目录

```text
~/.memory-manager/
  rules/
    global.md
    personal-style.md
    projects/
      <project-key>.md
```

## 最小可验证链路

实现命令：

```bash
memory-manager rules output --project Boarding_Desktop
memory-manager rules output --global
memory-manager rules output --style
```

生成命令：

```bash
memory-manager rules generate
memory-manager rules generate --full
```

## 输出规则

输出：

```text
high
verified
```

不输出：

```text
low
medium
needs_review
conflict
rejected
```

## P0-P6

P0-P6 只在 renderer 阶段用于最终文案优化，不参与 confidence。

| 准则 | 含义 |
| --- | --- |
| P0 | Token cost，保留值得长期占用上下文的内容 |
| P1 | Proximity，条件、动作、限制放在一起 |
| P2 | Specificity，使用具体命令、路径、动作 |
| P3 | Guardrails，优先写边界和禁止项 |
| P4 | Density，压缩重复表达 |
| P5 | Markdown style，标准 Markdown，命令和路径用反引号 |
| P6 | Verifiability，规则尽量可 yes/no 检查 |

## LLM Rewrite 限制

Renderer 可以调用 LLM 做 Markdown rewrite，但必须遵守：

```text
不能新增无证据 rule
不能改变事实含义
只能压缩、合并、重排、优化表达
```

## 写文件策略

写入前：

```text
render new content
compare with existing file
same -> skip write
changed -> atomic write
```

## 验收

必须证明：

1. `global.md` 只包含 high/verified global rules。
2. `personal-style.md` 只包含 high/verified personal style。
3. `projects/<project-key>.md` 只包含该项目 high/verified project rules。
4. medium/low/rejected 不出现在正式文件。
5. 内容不变时不重写文件。

## 渐进增强

后续增强：

1. 输出文件 content hash 记录。
2. 回滚历史版本。
3. 自定义输出路径。
4. 多项目批量 show。

## 非目标

MVP 不做：

1. `snapshots/` 目录。
2. `review.md` 文件。
3. `evidence.jsonl` 文件。
