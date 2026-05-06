# Plan 06: Confidence & Review

## 目标

为 LLM 生成的候选 rules 计算置信度，并支持人工 accept/reject/explain。

## 最小可验证链路

实现命令：

```bash
memory-manager rules review
memory-manager rules accept <rule-id>
memory-manager rules reject <rule-id>
memory-manager rules explain <rule-id>
```

## 置信等级

```text
low
medium
high
verified
```

正式输出只使用：

```text
high
verified
```

## 硬规则

```text
没有 evidence -> rejected
用户 accept -> verified
用户 reject -> rejected
与 verified 冲突 -> needs_review
unknown session 不能生成 high 项目 rule
单项目事实不能生成 high global rule
```

## 加分因子

```text
用户明确要求
repo 文件/脚本/CI 证据
多 session 重复
多 agent 重复
项目分类置信高
用户 accept
```

## 降分因子

```text
assistant-only
弱推断
source missing
project unknown
冲突
太泛泛
无 evidence
```

## DB 写入

`rule_candidates` 增加：

```text
confidence_score
confidence_level
status
decision_reason
```

可选解释表：

```text
rule_confidence_factors
  rule_id
  factor
  value
  weight
  explanation
```

## explain 行为

`rules explain <rule-id>` 应展示：

1. 当前 score 和 level。
2. 影响分数的主要因子。
3. evidence pointer。
4. 如果 source 还存在，回源读取相关片段。
5. 如果 source 缺失，标记 `source_missing`。

## 验收

必须证明：

1. 无 evidence rule 被拒绝。
2. `accept` 后变成 `verified`。
3. `reject` 后不进入正式输出。
4. `unknown` session 不会生成 high 项目 rule。
5. 单项目事实不会生成 high global rule。

## 渐进增强

后续增强：

1. 相似 rejected rule 自动降权。
2. 冲突规则聚合展示。
3. 批量 accept/reject。
4. 人工修改 ruleText 后重新评分。

## 非目标

本阶段不做：

1. Markdown 文件输出。
2. P0-P6 文案 rewrite。

