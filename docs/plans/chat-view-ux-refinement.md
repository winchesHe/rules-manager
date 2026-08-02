# Chat View 布局与交互体验收口

## 范围与验收标准

本轮只调整 Chat View 的布局、视觉层级和响应式过渡，不改变 Native Session、消息发送、
Session Context 注入或生命周期语义。

验收标准：

- 宽屏三栏具有稳定边界：Thread Rail 16rem、Context Pane 22rem，Conversation 保持弹性；
  Rail 折叠时连续过渡，不产生页面级横向滚动。
- Conversation 与 Composer 使用同一条 60rem 阅读对齐线；Tool 内容只能在自身容器内换行或滚动。
- Composer 的输入和本轮配置合并为一个操作 Surface，宽度、焦点反馈和层级一致。
- 右侧明确拆分 Chat 管理、运行上下文与 Session 上下文；已选 Session 不得无限撑高页面。
- 视口不大于 1600px 时 Rail / Context 转为带遮罩的 Sheet，避免全局导航挤压主对话；打开关闭具备 200ms 过渡，
  `prefers-reduced-motion` 下禁用动画。
- App 定向测试、全量测试与 production build 通过，并至少在 1024、1440、1920 三档完成截图验收。

## Step 1：锁定布局契约

只新增 Chat View 结构测试，描述三栏尺寸、共享阅读线、Composer Surface、右侧分区和动画降级。

- 观察点：定向测试在旧实现上明确失败。
- 验证方式：运行 `npm test -- --runInBand test/home-workflow-layout.test.ts`，确认失败项只来自新契约。

## Step 2：调整三栏、Conversation 与 Composer

只修改 Chat View 的桌面布局、Sheet 过渡、阅读宽度、Tool 溢出和 Composer Surface。

- 观察点：宽屏无页面横向滚动，消息与 Composer 左右边界一致；收起 Rail 时中心栏平滑扩展。
- 验证方式：定向测试转绿，并在 1920 / 1440 截图检查对齐线和溢出。

## Step 3：重组右侧上下文

只重排右侧 Chat 管理、运行元数据、Session 选择和隐私说明，不改变数据与操作。

- 观察点：Session 选择成为右栏主任务，运行信息压缩为两列，已选项区域有最大高度。
- 验证方式：定向测试转绿；真实选择、移除 Session，确认过滤、日期和滚动仍可用。

## Step 4：全量验收与上下文同步

只执行格式/测试/build、三档真实窗口检查，并记录本轮决策。

- 观察点：1024 使用 Sheet；1440 不挤压 Conversation；1920 三栏平衡，动画无跳变。
- 验证方式：App 全量测试、Core 全量测试、两端 production build 全绿；结果写入
  `memory/process.md`。

## 验收结果

- 1728×979：桌面三栏，Thread Rail / Conversation / Context Pane 比例稳定。
- 1440×900：Conversation 独占主区，Context Sheet 的遮罩、滚动和信息分区通过实看。
- 1024×768：正文、Tool 卡片和 Composer 无页面级横向滚动，配置项允许自然换行。
- Core 26 suites / 277 tests、App 20 suites / 127 tests 全绿；双端 production build 与
  `git diff --check` 通过。

## Follow-up：去除常驻抬头与运行信息

- 顶部 Chat 标题与说明移除，Workspace Card 直接占满 Chat 可用高度。
- 右侧移除任务抬头、对话管理与运行上下文，直接从 Session 上下文开始。
- 重命名、Archive、恢复、永久删除与 resume-failed 续开收进 Thread Rail 顶部 `…` Modal；
  Rules 运行中的停止操作进入悬浮 Action，不丢失原功能。
- 观察点：桌面首屏不再出现用户标注的两个冗余区域，Conversation 与 Session Context 同顶对齐。
- 验证方式：真实 Electron 1728×979 截图确认；定向布局测试与 App production build 通过。
