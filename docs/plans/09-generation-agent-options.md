# Plan 09 · 生成任务 Agent 选项

## 范围与验收标准

- Generate 发起页可以选择 Claude / Codex、对应 Model、Reasoning Effort，并开关 Fast Mode。
- 初始值来自当前 Settings；选择只作用于本次任务，不改写全局配置。
- Model 列表随 Agent 切换，来源与 Settings 的 Provider catalog 保持一致。
- 选项随 Generation Request 进入 Worker，并由 Rules Generation 调用链实际使用。
- Chat Thread 持久化本次选项，Chat Context 可查看 Agent、Model、Effort、Fast Mode。
- 旧请求未携带新字段时继续使用 Settings 默认值，旧 Chat Thread 可正常读取。

## Step 1 · 建立端到端最小契约

只扩展 Generation Request、IPC 校验、Worker 参数和 Chat Thread 请求快照。

- 观察点：Worker 收到的 request 与 Chat Thread 的 `request` 都包含本次选项（包括 Model）。
- 验证方式：GenerationController / ChatStore 单元测试断言字段完整保留；Core 测试断言显式选项覆盖全局默认。

## Step 2 · Generate 选择器

只在 Generate 发起页增加 Agent、Model、Effort、Fast Mode 控件，并从 Settings 加载初始值与 Model catalog。桌面端将 Evidence scope 与完整 Agent 配置分成左右两栏；配置项内部仍采用左侧标签、右侧控件的横向结构。

- 观察点：Evidence scope 位于左栏，完整 Agent 配置位于右栏；四个配置项的标签与控件左右分布；窄屏回退为单栏。禁用 Provider 不可选，切换 Agent 会更新 Model，发起按钮在配置加载完成前不可用。
- 验证方式：APP 布局契约测试检查控件与请求字段；production build 验证组件 API 和类型。

## Step 3 · Chat Context 展示

只在已持久化 Thread 的 Context 中展示本次运行选项。

- 观察点：进入新生成任务的 Chat 后，可看到 Agent、Model、Effort、Fast Mode。
- 验证方式：ChatStore 恢复测试检查请求快照；APP 布局契约测试检查三个 Context 字段。

## Step 4 · 完整回归

- 观察点：Core / App 无新增失败，构建产物可生成。
- 验证方式：`npm test`、Core/App production build、`git diff --check`。

## Step 5 · 生成入口视觉层级收敛

移除包裹整页的大型 Card 与脱离任务上下文的全局底栏。桌面端改为左侧主 Evidence
选择区、右侧固定宽度“本次运行”面板；运行参数使用紧凑行，范围摘要和主操作收进
右侧面板底部。窄于 1100px 时仍回退为单栏。

- 观察点：首屏没有嵌套大卡片与大块无效留白；Evidence 是视觉主区，Agent 配置位于
  右侧且明显属于本次运行；“继续进入对话”紧邻本次运行摘要。
- 验证方式：APP 布局契约检查 launcher、双栏比例和 action 归属；启动真实 App，
  在生成规则页面做截图对账。
