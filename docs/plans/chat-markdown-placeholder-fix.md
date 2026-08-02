# Chat Markdown 占位骨架修复

## 改动范围

- 保留 `markstream-react` 流式 Markdown 渲染。
- 关闭依赖可视区观察器的节点延迟渲染与节点分批占位，避免 Electron 自定义滚动容器中出现无法解除的灰色骨架。
- 不改变长回复的 Markdown 语义、Tool Activity、复制与耗时布局。

## 验收标准

1. 截图对应的已完成长回复滚动到底部时不再出现灰色 `node-placeholder`。
2. 标题、列表、行内代码、链接与代码块继续正常渲染。
3. 流式消息仍使用 `final=false`，历史消息仍使用 `final=true`。

## 验证方式

- Renderer 契约测试锁定 `deferNodesUntilVisible={false}`。
- 真实 Electron 长回复滚动检查。
- App 全量测试、production build 与 `git diff --check`。
