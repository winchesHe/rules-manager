# Plan 05: LLM Rule Generation

## 目标

通过 `pi-code-agent` SDK 从已分类 session 中生成候选 rules，并确保 DB 只保存候选规则和 evidence pointer。

## 前置能力边界

已落地的 `rules list [agent]` / `rules show <agent>` 只发现和读取 agent live 全局 instruction source，不是候选规则存储。本 Plan 后续可将 effective source 作为显式上下文输入，但不得把其正文写入 DB、evidence pointer 或日志，也不得在生成过程中修改 live 文件。

`rules generate` 与上述只读 source 命令共享 `rules` namespace，但数据模型保持分离；实现前需另行补齐 schema 与敏感内容裁剪 spec。

## LLM 接入

调用链路：

```text
memory-manager -> pi-code-agent SDK -> LiteLLM 风格接入
```

配置：

```toml
[llm]
mode = "openai-response"
model = "gpt-5.4"
effort = "high"
```

MVP 测试默认使用 mock LLM。

## 最小可验证链路

实现：

```bash
memory-manager rules generate --dry-run
memory-manager rules generate
```

流程：

```text
changed/full sessions
  -> 回源读取 source content
  -> excerpt selection
  -> redaction
  -> LLM extract/merge
  -> schema validation
  -> evidence pointer validation
  -> 写入 rule_candidates
```

## EvidenceBundle

LLM 输入必须是裁剪后的 evidence bundle，不是完整 session。

```ts
type EvidenceBundle = {
  target: "project" | "global" | "personal_style";
  mode: "incremental" | "full";
  project?: {
    key: string;
    slug: string;
    rootPath?: string;
  };
  sessions: Array<{
    sessionId: string;
    agent: AgentName;
    projectKey?: string;
    updatedAt: string;
    excerpts: Array<{
      locator: string;
      role: "user" | "assistant" | "tool" | "system" | "unknown";
      text: string;
      reason: string;
    }>;
  }>;
  existingRules?: Array<{
    id: string;
    scope: string;
    projectKey?: string;
    ruleText: string;
    status: string;
    confidenceLevel: string;
  }>;
};
```

## Excerpt Selection

片段选择优先级：

1. 用户明确说“规则”“以后”“不要”“必须”“偏好”。
2. 涉及命令、测试、构建、发布、调试。
3. 涉及路径、目录、配置、项目结构。
4. 用户纠正 assistant。
5. 多次重复出现的行为。
6. assistant 总结只作为低优先级。

## LLM 输出要求

输出必须是结构化 JSON。

硬规则：

1. 没有 evidence 的 candidate 拒绝。
2. `scope=project` 必须有 `projectKey`。
3. `global` 不能只靠单项目事实。
4. `personal_style` 不能包含项目事实。
5. evidence locator 必须可回源验证。

## 三类候选

| scope | 内容 |
| --- | --- |
| `project` | 项目事实、命令、约束、工作流 |
| `global` | 跨项目稳定规则或用户明确全局偏好 |
| `personal_style` | 用户交互偏好，不包含项目事实 |

## 验收

必须证明：

1. `rules generate --dry-run` 不写 DB、不写文件。
2. `rules generate` 写入 `rule_candidates`。
3. DB 不保存完整 session content。
4. 无 evidence candidate 被拒绝。
5. mock LLM 可稳定测试 schema validate 和 retry。

## 渐进增强

后续增强：

1. extract 和 merge 拆成独立 LLM 调用。
2. repo facts 加入 evidence bundle。
3. 更细粒度 token/字符预算。
4. LLM run 统计 token usage。

## 非目标

本阶段不做：

1. 最终 Markdown rewrite。
2. 人工 review 命令。
3. 自动接受高置信规则。
