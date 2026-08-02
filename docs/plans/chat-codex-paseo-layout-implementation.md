# Chat · Codex / Paseo 布局真实实现

## Goal

将已确认的 `docs/prototypes/chat-codex-paseo-layout.html` 落到真实 Electron Renderer。
最终真实 App 的 Chat 布局必须与基线截图同构，同时保留并可操作现有 Chat、Rules Run、
Session Context 与主题能力；不能用静态假数据或仅视觉相似替代真实功能。

视觉基线：

- 默认态：`docs/prototypes/chat-codex-paseo-layout-preview.png`
- Session Context 收起态：`docs/prototypes/chat-codex-paseo-layout-collapsed-preview.png`
- Chat 历史 Drawer：`docs/prototypes/chat-codex-paseo-layout-history-preview.png`

## 完整改动范围

- App Shell：保留 14rem 产品导航和主题切换，Chat 工作区去掉页面 padding 与外层 Card；移除
  “Workspace”产品概念。
- Chat Header：显示当前标题、对话管理与唯一 Session Context 开关；点击标题打开历史 Drawer。
- Chat 历史：将现有常驻 16rem/4rem Thread Rail 改为 18rem 覆盖式 Drawer，保留 New Chat、
  Active/Archived、选择、重命名、归档、恢复、删除和 resume-failed 续开。
- Conversation：正文与 Composer 共享 820px 阅读线；短对话靠近底部；用户气泡、Assistant 正文、
  Activity timeline、复制与耗时对齐原型。
- Composer：输入与运行控件保持单 Surface；保留 Provider/model/effort/fast/Skills、发送/停止/队列、
  Full access 与 Provider 权威 Context Window；增加 Session Context 快捷入口与数量。
- Session Context：22rem 可收起 Pane，保留项目/日期查询、分页虚拟列表、选择/移除、来源失效和隐私说明；
  重排为已选 → 筛选 → 可选列表。桌面收起偏好本地持久化，窄屏使用覆盖式 Drawer。
- 响应式与可访问性：Drawer/Pane 支持遮罩、Escape、`inert`、焦点可见与 reduced motion，页面无横向滚动。
- 文档与测试：更新过期的常驻三栏、16rem Rail 和 60rem 阅读线契约，并同步 `DESIGN.md`、专项 spec
  与 `memory/process.md`。

## 不改变的业务边界

- 不修改 ChatStore 文件格式、Native Session 绑定、Provider adapter、IPC 协议、Rules Generation、
  Session Context 注入协议和隐私红线。
- 不删除 Fast Mode、Skills、Thread 生命周期、Rules Artifact、重新生成、停止、队列或 Tool 原文按需读取。
- HTML 中没有直接展示的 Fast Mode / Skills 收入 Composer 的次级配置入口，不能因视觉对齐而功能倒退。

## 验收标准

1. 1728×979 真实 Electron 默认态与 HTML 基线同构：14rem 全局导航、48px Chat Header、
   弹性 Conversation、22rem Session Context、820px Composer，无常驻 Thread Rail 和外层 Card。
2. 点击标题打开 18rem 历史 Drawer；Drawer 覆盖 Conversation 而不重排主 Grid，所有 Thread 生命周期操作可用。
3. Session Context 可从 Header 和 Composer 打开；收起后中央列获得全部 22rem，重启后恢复桌面偏好。
4. 发送、流式消息、停止/队列、Provider/model/effort/fast/Skills、Tool 展开、Context 选择和 Rules 操作无回归。
5. 1600px 及以下使用覆盖式历史/Context Drawer；1024×768 无页面级横向滚动。
6. 主题切换在新版布局有效；中文和英文界面不存在缺失 key。
7. 定向布局/交互测试、App/Core 全量测试、App/Core production build 与 `git diff --check` 全部通过。
8. 输出真实 App 的默认、Context 收起、历史 Drawer 三张截图，并与 HTML 三张基线逐项对照。

## 观察点与验证方式

- 先更新结构契约测试，让旧实现因常驻 Rail、外层 Card、60rem 阅读线和缺少 Context 持久化明确失败。
- 每完成一个布局区块运行 App 定向测试；完成交互后用真实 IPC 数据 smoke，而不是只加载静态组件。
- 最后以 1728×979、1440×900、1024×768 三档启动 Electron，检查滚动所有权、遮罩、展开/收起、主题与视觉对齐。
- 最终执行两端全量测试和 production build，并把截图、尺寸与功能核对结果写入过程记录。
