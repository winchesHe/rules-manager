# 实现记录

## 公开仓库基线（2026-08-26）

- 从公开快照移除 `.opencode` 本机任务状态、旧进度状态文件和不可可靠文本审计的二进制原型截图。
- 将 Claude、Codex、Copilot、Cursor 的真实 Session fixture 替换为最小合成 JSONL，保留解析、分类、扫描和项目操作测试覆盖。
- 公开示例项目统一使用 `atlas-desktop`、`orbit-cli`、`memory-lab` 和 `sample-browser-extension`。
- 新增中文 README，说明产品定位、本地优先隐私模型、快速开始、CLI、桌面端和开发命令。
- GitHub About 使用本地优先 Session 管理定位；不添加许可证。
- 修正 App Rules 启动时序测试对固定历史日期的依赖，使最近 7 天查询在任意执行日期都稳定命中测试 Session。
- App 独立 `typecheck` 仍受既有跨 workspace `rootDir` 与组件类型错误阻塞，不作为本次公开清理的新增问题。
- 验证通过：Core 41 suites / 406 tests、App 45 suites / 289 tests、Evals 6 suites / 25 tests、Core production build、App production build 与 `git diff --check`。
- 公开树扫描未发现公司链接、本机用户名、真实 Session 标识、常见凭据模式、私钥或数据库文件；依赖安装报告 6 个既有漏洞（1 low / 1 moderate / 4 high），未在本次文档与脱敏范围内升级依赖。
- 提交信息：`docs: 准备公开仓库快照`

## T3 Code 会话数据源第一阶段

实现只读 v2 线程枚举和快照读取，保留 provider 原生 ID 关联及消息作者。定向单测 3 项通过，真实库中按标题命中单条线程并回读消息。下一阶段接入扫描、查询、实时读取及别名去重。
