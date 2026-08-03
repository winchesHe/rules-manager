# App 项目已导出规则查看入口

## 目标

在「项目 → 项目详情 → 规则」中增加「候选规则 / 已发布版本」切换，只读查看由“导出该项目规则文件”
写入的 `~/.memory-manager/rules/projects/<project-slug>.md`。

这里沿用当前 UI 的用户用语“已发布版本”，但页面需要明确说明：该文件是 Memory Manager 托管的项目规则
导出，不代表已发布到 Claude/Codex Memory。

## 范围与安全边界

- Renderer 只提交项目 slug；主进程使用 `normalizeSlug` 校验后固定解析到 workspace rules 目录。
- 不接受任意文件路径，不读取其他项目、global、personal-style 或 Agent Memory 文件。
- 文件缺失作为正常“尚未导出”状态返回，不自动创建或重新导出。
- 单文件上限 1 MiB，要求有效 UTF-8；读取前后 stat 必须一致。
- 页面只读展示路径、正文、大小、修改时间和刷新入口，不提供编辑或删除。

## 执行与观察点

| 步骤 | 改动 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|---|
| 1 | Core published output reader | slug 不能逃逸固定目录；missing 正常返回；读取不修改文件 | 临时 HOME 单测覆盖 present、missing、非法 slug、超限、非法 UTF-8、读取竞态与 hash | 已完成 |
| 2 | Electron IPC | Renderer 只能传 slug，不能传 path | IPC 源码契约测试 | 已完成 |
| 3 | 项目规则 UI | 候选规则与已发布版本可切换；路径、内容、时间、空态、刷新清晰 | App 布局/i18n 定向测试 | 已完成 |
| 4 | 真实验收 | 现有导出文件可查看；未导出项目显示空态；不会触发导出或发布 | 全量测试、build、本机 hash smoke、真实 Electron 视觉检查、`git diff --check` | 已完成 |
| 5 | 上下文同步 | 行为、证据和语义限制可接续 | 更新 `memory/process.md` 并复核 staged diff | 已完成 |

## 验收标准

1. 项目详情的「规则」页同时提供「候选规则」和「已发布版本」。
2. 已发布版本读取固定的 `<workspace>/rules/projects/<slug>.md`，页面不允许提交任意路径。
3. 未导出、超限、非法 UTF-8、读取期间变化均有明确状态或错误。
4. 页面不修改文件、候选状态、DB schema 或 Agent Memory。
5. 页面文案区分“项目规则文件导出”与“发布到 Agent Memory”。
