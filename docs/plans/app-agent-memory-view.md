# App Agent Memory 只读入口

## 目标

在现有「规则」二级导航中保留「Agent 指令」，新增独立的「Agent Memory」入口，只读展示
Claude 与 Codex 自动生成的 Memory 主入口。

## 范围与安全边界

- Claude：扫描 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/memory/MEMORY.md`，每个现存项目
  Memory 返回一条来源；项目编码只作为不透明 ID，不尝试反解真实仓库路径。
- Codex：展示 `${CODEX_HOME:-~/.codex}/memories/MEMORY.md` 固定来源；该来源是 Codex 本机统一
  Memory，不伪装成按项目拆分的数据。
- 只读取主入口 `MEMORY.md`，不递归读取 Claude topic 文件、Codex raw/summary/evidence 文件或私有
  SQLite。
- 正文不写入 Memory Manager DB、日志、缓存或副本；不提供编辑、删除、生成或合并操作。
- 单文件上限 1 MiB，要求有效 UTF-8，并用读取前后 stat 一致性防止后台更新产生撕裂内容。
- Claude 不跟随 `projects/*` 目录 symlink；允许最终 `MEMORY.md` 为文件 symlink。

## 执行与观察点

| 步骤 | 改动 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|---|
| 1 | Core locator 与安全读取 | Claude 多项目稳定排序；Codex 固定 present/missing 槽位；无 workspace/DB 副作用 | 临时 HOME 单元测试覆盖多项目、环境变量、symlink、missing、超限、非法 UTF-8、读取竞态 | 已完成 |
| 2 | Electron IPC 与 Renderer 类型 | Renderer 只能提交 `agent + memoryId`，不能提交任意路径 | IPC 源码契约测试与非法参数测试 | 已完成 |
| 3 | Rules 导航与 Agent Memory 页面 | 原「Agent 指令」保留；新增「Agent Memory」；列表展示 Agent、scope、路径、状态，点击后查看只读正文 | App view-model / 布局契约测试，中文与英文文案对账 | 已完成 |
| 4 | 本机只读验收 | 本机 Claude Memory 可列出并读取；Codex 缺失时明确显示未生成；源文件 hash 不变 | Core/App 全量测试、build、CLI/Node smoke、真实 Electron 视觉检查、`git diff --check` | 已完成 |
| 5 | 上下文同步 | 最终行为、验证证据与遗留限制可接续 | 追加 `memory/process.md` 并复核 diff | 已完成 |

## 验收标准

1. Rules 二级导航同时存在「Agent 指令」「Agent Memory」「生成的规则」。
2. Agent Memory 页面只展示 Claude/Codex 自动 Memory，不混入 `CLAUDE.md`、`AGENTS.md` 或候选规则。
3. Claude 多项目可逐项打开；Codex 缺失时仍显示固定来源和“尚未生成”的明确状态。
4. 内容查看为只读，重新加载会重新从原路径发现与读取。
5. 任意路径注入、未知 ID、缺失来源、超限、非法 UTF-8 和读取期间变化均明确失败。
6. 不修改 DB schema，不创建 workspace，不修改任何 Agent Memory 文件。
