# 公开仓库清理

## 目标

在不削弱 adapter、扫描、分类和项目操作回归覆盖的前提下，生成可公开审计的仓库快照。

## 观察点与验证方式

| 观察点 | 处理 | 验证方式 |
|---|---|---|
| `.opencode` 包含本机任务状态 | 从仓库移除并加入 `.gitignore` | `git ls-files .opencode` 为空 |
| 四类测试源来自真实 Session | 替换为最小合成 JSONL，保留各 Agent 格式差异 | adapter、classifier、scan、projects 定向测试 |
| 过程状态与截图不可可靠脱敏 | 移除旧状态文件与二进制截图，保留可文本审计的规格和 HTML 原型 | 文件清单与敏感词扫描 |
| README 与 GitHub About 为空 | 补齐定位、隐私模型、快速开始、命令和开发说明 | Markdown 检查与 GitHub 写后回读 |
| 公开快照不能携带旧敏感历史 | 使用清理后的工作树生成单个根提交 | 用户完成远端引用替换后复查 commit graph |

## 验收标准

1. 四个合成 fixture 分别被 Claude、Codex、Copilot、Cursor adapter 识别。
2. 分类结果稳定为 `atlas-desktop`、`orbit-cli`、`memory-lab`、`sample-browser-extension`。
3. Core 与 App 全量测试和生产构建通过；既有 App typecheck 问题单独披露。
4. 当前公开树不包含 `.opencode`、真实 Session、公司链接、本机用户名或常见凭据模式。
5. GitHub About 包含准确描述和主题；仓库仅在旧引用清理完成后改为公开。
