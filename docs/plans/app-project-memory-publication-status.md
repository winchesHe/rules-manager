# App 项目 Memory 发布状态与入口

## 目标

在「项目 → 项目详情 → 规则 → 已发布版本」中展示当前项目规则发布到 Claude Project Memory 与
Codex 项目 Memory 的实际状态，并提供进入既有安全发布流程的入口。

## 语义与边界

- 状态事实源是当前项目全部 accepted project rules 与各 Memory Manager 受管目标内容的一致性，不以
  `rules/projects/<slug>.md` 是否存在代替 Memory 发布状态。
- 每个目标区分 `已同步 / 有更新 / 未发布 / 不可用`；Claude 目标不按 project slug 自动映射，只有受管
  block 明确属于当前项目时才算该项目的发布记录。
- “发布到 Memory”只导航到现有已接受规则发布页，自动选择当前项目与该项目全部已接受规则；Claude
  Memory 目标和 Codex cwd 仍需用户明确选择，项目页不直接写入 Memory。
- 状态检查只读，不创建、修改或删除导出文件、Memory、note 或数据库记录；Codex Session 解析继续放在
  Worker 中，避免阻塞 Electron 主线程。

## 执行与观察点

| 步骤 | 改动 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|---|
| 1 | Core 状态模型 | accepted rules 与 canonical managed 内容一致时为已同步，变化后为有更新 | Claude/Codex 临时 HOME 单测 | 已完成 |
| 2 | Worker 与 IPC | Renderer 仅提交 project slug，状态读取不阻塞主进程 | IPC/构建契约测试 | 已完成 |
| 3 | 项目详情 UI | 两类 Memory 状态、目标摘要、刷新与发布入口清晰 | 布局/i18n 定向测试 | 已完成 |
| 4 | 发布页预选 | 当前项目与全部 accepted project rules 自动选中，目标仍为空 | Renderer 契约测试与真实 Electron 检查 | 已完成 |
| 5 | 完整验收 | 已同步、过期、未发布、不可用和导航均可观察 | 全量测试、build、真实 Electron、`git diff --check` | 已完成 |

## 验收标准

1. 已发布版本页能分别看到 Claude 与 Codex Memory 状态，且不会把托管导出文件误判为已发布。
2. 状态基于受管内容精确比较；当前 accepted rules 变化后显示“有更新”。
3. 发布入口复用既有 CAS、symlink、marker、大小和目标选择安全约束。
4. 从项目进入发布页时自动带入项目及全部 accepted project rules，但不自动选择 Claude/Codex 目标。
5. 状态检查与视觉验收不写入本机 Memory。
