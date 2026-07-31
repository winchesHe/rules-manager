# Evidence 上下文资格标识

## 范围与验收标准

- 不改变当前规则生成算法，不删除或改写历史候选。
- 来源查看器重新判断 locator 对应消息的 Evidence 资格。
- AGENTS / CLAUDE 注入与纯平台上下文显示为“已排除”，不再显示“Evidence 命中”。
- 只有真实用户消息继续显示“Evidence 命中”。

## Step 1：Core 返回资格

- 单一改动：在按需上下文结果中增加 `eligible / existing_rule_baseline / platform_context`。
- 观察点：同一个 OpenCode Session 中，AGENTS 注入为 baseline，普通用户消息为 eligible。
- 验证方式：Core Evidence 单测。

## Step 2：审核页修正语义

- 单一改动：根据资格切换命中标签与说明。
- 观察点：历史 locator 仍可查看，但基线消息明确显示“不参与生成”。
- 验证方式：App UI 契约与 production build。

## Step 3：回归与记录

- 单一改动：同步设计与过程记录并完成全量验收。
- 观察点：历史数据保留、当前生成过滤逻辑不变。
- 验证方式：Core/App 全量测试、build、`git diff --check`。
