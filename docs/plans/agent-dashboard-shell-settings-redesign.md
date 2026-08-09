# Agent Dashboard 侧栏与设置迁移

## 目标

在不改变现有 Scan / Projects / Chat / Rules、Provider 配置和主题持久化行为的前提下，
将已确认的侧栏与设置视觉结构迁入真实 Electron App，并把面向用户的产品名统一为
`Agent Dashboard`。

## 范围

- 主侧栏改为 178px 左右的固定窄栏，增加 Workspace / Knowledge 分组，设置固定在底部。
- 去除导航选中态的绿色装饰；既有 Codex 炭灰深色与白蓝浅色主题保持不变。
- 设置不再切换到另一套全屏外壳，而是在同一个 App Shell 内展示分区菜单与 Setting Row。
- 保留侧栏主题快捷按钮，同时在“通用”设置中提供主题选择，与语言设置并列。
- Provider 启停、详情、模型、推理强度、Fast Mode、语言和主题持久化行为保持不变。
- Renderer、窗口标题和 Agent 宿主提示中的产品名改为 `Agent Dashboard`；CLI 命令、npm 包名、
  `.memory-manager` 工作区、IPC 名称和受管文件标记保持不变。

## 观察点与验证方式

| 观察点 | 验证方式 |
|---|---|
| 所有主页面共享同一侧栏，进入设置不会换壳 | App Shell 源码合同测试 + Electron 视觉检查 |
| 侧栏导航仍指向现有四个模块，Rules 二级导航保持工作 | App Shell 源码合同测试 + App 全量测试 |
| 设置页拥有固定 viewport，高度内独立滚动 | 布局合同测试 + Electron 视觉检查 |
| 主题、语言、Provider 与生成默认项交互不变 | 既有 theme/i18n/provider 测试 + App 全量测试 |
| 既有炭灰深色与白蓝浅色 token 不发生变化 | theme 定向测试 + Electron 深浅主题视觉检查 |
| 用户可见产品名统一为 Agent Dashboard | 品牌合同测试 + production build |

## 不在本轮

- 不重命名仓库目录、npm workspace、CLI 二进制、`.memory-manager` 数据目录或数据库。
- 不新增预览稿中的虚构导航、设置开关或未实现数据。
- 不重做概览、扫描、项目、Chat、规则各页面的主体信息架构。
