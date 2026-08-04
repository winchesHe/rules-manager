# Chat 思考正文与单工具展示修复

## 改动范围

- Native Chat Timeline 中，有正文的 Thinking 默认直接展示正文，不再要求二次展开。
- Thinking 正文复用 Assistant 的 Markstream 渲染器，支持加粗、列表、行内代码等 Markdown，并保留较弱的
  Thinking 文字层级与流式渲染状态。
- Codex 的每个 `turn/start` 显式请求 `summary: "auto"`，让 App Server 返回可读推理摘要事件。
- Provider 未提供正文的空 Thinking 不渲染，避免出现无法查看内容的占位节点。
- 空 Thinking 在分组前即忽略，不作为 Tool 阶段边界；只有可见 Thinking 才切分前后工具组。
- Codex Tool 使用 `sourceLocator.turnId` 作为阶段边界：同一 Turn 内的连续调用聚合，不跨 Turn 合并；缺少
  locator 的旧数据继续按可见相邻关系兼容分组。
- 同一阶段只有一条 Tool activity 时直接展示单条工具卡；连续两条及以上时才显示分类汇总组。
- 不生成或推断 Provider 未返回的隐藏推理内容，不修改 ChatStore 数据结构与工具详情回源协议。

## 验收标准

- `content` 非空的 Thinking 同时显示“思考”标题与正文，页面初始状态即可阅读。
- Thinking 中的 `**加粗**`、列表和行内代码按 Markdown 渲染，不显示原始标记符号。
- 新发起的 Codex Turn 在协议请求中包含 `summary: "auto"`，并消费 `summaryTextDelta` 形成正文。
- `content` 为空或仅空白的 Thinking 不产生可见行。
- 单条 Shell activity 直接显示 `Command + 摘要`，不出现“运行 1 条命令”组头。
- 两条及以上连续 Tool activity 仍按 Read / Search / Shell / Tool 分类汇总，可展开逐条详情。
- Assistant 或 Thinking 继续作为相邻 Tool 分组的边界。
- 空 Thinking 不切断相邻工具；有正文 Thinking 继续作为相邻 Tool 分组的边界。
- 不同 `sourceLocator.turnId` 的工具不会合并为同一组；各 Turn 只有一条工具时均直接展示。

## 验证方式

- Timeline 纯函数测试覆盖单条直出、多条分组与阶段边界。
- Renderer 合同测试覆盖空 Thinking 过滤、Thinking 正文直显和单工具渲染分支。
- Markdown 合同测试覆盖 Thinking 复用 Markstream 及其专用视觉层级。
- Codex Adapter 协议测试覆盖 start / resume 的 reasoning summary 请求。
- App 全量测试、Core 全量测试、production build 与 `git diff --check`。
