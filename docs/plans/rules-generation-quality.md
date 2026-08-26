# Rules 生成质量加固

## 目标与范围

在不把对话原文写入数据库、也不扩大 Provider 写权限的前提下，提高 Rules 生成的召回率、scope 准确性和候选可复用性。本轮只调整 Evidence 临时上下文、生成 Prompt 与 Provider 返回后的本地资格校验，不改数据库 schema、审核 UI 或发布语义。

## 设计对齐

### 自适应读取

- Evidence 正文总量不超过 128 KiB 时使用 `complete`：要求读取 manifest 列出的全部 batch，避免小样本被关键词检索漏掉。
- 超过 128 KiB 时使用 `selective`：先用 Grep/Glob 找规则信号，再读取命中位置附近上下文；结束前检查每个 batch 是否至少参与过搜索，未命中的 batch 只能记为“已搜索无命中”，不能假装已阅读。
- manifest 显式写入 `readingStrategy / totalBatchBytes`，Prompt 只描述当前项目实际采用的策略。
- `frequency` 明确为“标准化后的整条用户消息完全一致”的跨 Session 次数，是重复信号的保守下界，不冒充语义频次；语义改写必须由 Agent 通过多条 locator 独立核对。

### Scope 边界

- 单项目 Evidence 默认只能支持 project rule。
- 只有被引用的真实用户消息明确表达跨项目、所有任务或普遍交互偏好时，才允许 global。
- 本地校验规范化 Provider 输出：project 一律绑定当前项目 slug；缺少全局证据的 global 降级为当前 project；合法 global 清空 project slug。
- 不允许 Provider 通过伪造或其他项目 slug 越过当前 Evidence bundle。

### Rule 质量门槛

- 候选必须是未来任务仍能指导 Agent 行为的持久 instruction。
- 排除一次性任务、状态描述、普通项目事实、日志/代码/文档内容、临时 workaround 和仅由 Assistant 提出的做法。
- 每条规则保持单一行为，写清触发条件、动作与必要边界，不得把 Evidence 支持的局部要求泛化。
- high / medium 只表示证据强弱；无法由明确用户信号支持的 low 推断不生成。Provider 仍返回 low 时由本地资格校验过滤。

## 可独立验证步骤

### 1. 写入读取策略元数据

只修改 Evidence Context 的 manifest 与返回类型。

- 观察点：小 bundle manifest 为 `complete`，超过阈值的 bundle 为 `selective`，并记录正确总字节数。
- 验证方式：`evidence-context.test.ts` 用可控 batch 大小覆盖两种策略，断言 manifest 和 Project Context 一致。

### 2. 生成与策略匹配的 Prompt

只修改 Prompt 文案，不改变 Provider 调用方式。

- 观察点：complete Prompt 要求完整阅读；selective Prompt 要求检索、局部阅读和逐 batch 覆盖检查；两者都说明 frequency 下界、scope 边界与 Rule 资格。
- 验证方式：`rule-candidates-generate.test.ts` 分别捕获两个 Prompt，断言互斥策略和共同质量契约。

### 3. 本地规范化 scope 与过滤低质量候选

扩展现有 `qualifyCandidates`，继续在持久化和 Chat response 之前执行。

- 观察点：错误 project slug 被纠正；无全局证据的 global 被降级；有明确全局措辞的 global 保留且无 project slug；low、伪造 locator、Assistant-only、Baseline 重复项被过滤。
- 验证方式：构造混合 Provider 返回，断言最终 response、dry-run 输出和数据库候选都只包含规范化后的合格项。

### 4. 全量回归

- 观察点：既有 Claude/Codex 结构化输出、Evidence 隐私和多项目失败隔离保持不变。
- 验证方式：运行 Core 定向测试、`npm test`、`npm run build` 与 `git diff --check`。

## 非目标

- 不新增第二次 LLM merge 调用；global 依赖用户明确的跨项目意图，而不是从单项目行为猜测。
- 不做不透明的本地“语义 frequency”算法，避免相似文本误聚类后虚增置信度。
- 不自动接受或发布候选。
