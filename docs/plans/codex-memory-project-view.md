# Codex Memory 项目级视图

## 目标

解析 Codex `~/.codex/memories/MEMORY.md` 中每个 `# Task Group` 的 `applies_to: cwd=...`，在不复制、
修改 Memory 文件的前提下，按工作目录聚合并只读展示项目级 Memory。

## 解析契约

- 一个 Task Group 从 `# Task Group:` 标题开始，到下一个同级 Task Group 标题或文件末尾结束。
- 只读取 Task Group 元数据中的 `applies_to:`；从分号前的 `cwd=` 子句提取绝对路径。
- `cwd=/a and /b`、`cwd=/a or /b` 同时归入两个项目；不以 `/` 开头的描述性范围不伪装成项目路径。
- 同一 cwd 的多个 Task Group 按原文件顺序合并，正文保持原样，不重写或缓存。
- 项目 source id 由 cwd 的 SHA-256 摘要生成，不把任意路径当作读取参数。

## 安全与兼容边界

- 继续保留 Codex 本机合并 `MEMORY.md` 主入口；项目条目是同一文件的虚拟只读切片，不是独立文件。
- 继续执行 1 MiB、UTF-8、读取前后 stat 一致性校验；解析失败只报告错误，不降级读取私有 SQLite。
- `memories show codex` 的无 id 行为仍指向全局 `memory` 主入口，避免新增项目切片破坏既有调用。
- 不修改 SQLite schema，不向 Memory Manager DB、日志或缓存写入 Memory 正文。

## 执行与观察点

| 步骤 | 改动 | 观察点 | 验证方式 | 状态 |
|---|---|---|---|---|
| 1 | 独立 Codex Markdown 解析器 | 多 Task Group、多 cwd、无效范围、顺序与去重正确 | Core 单元测试 | 已完成 |
| 2 | Auto Memory 来源与读取 | 全局 source 保留，项目 source 可按 id 读取对应切片 | Core 单元测试与只读 hash 校验 | 已完成 |
| 3 | Agent Memory 项目级 UI | Codex 项目名称、cwd、Task Group 数量和作用域清楚 | App 契约测试与真实截图 | 已完成 |
| 4 | 完整验收 | 无写盘、副作用或既有 Claude/Codex 回归 | Core/App 全量测试、build、`git diff --check` | 已完成 |

## 验收标准

1. Agent Memory 列表保留一条“Codex 本地 Memory”，并按 `applies_to.cwd` 增加 Codex 项目条目。
2. 同一 cwd 的多个 Task Group 合并为一个项目条目，详情只显示属于该 cwd 的原始 Task Group。
3. 一个 Task Group 指向多个绝对 cwd 时在各项目下均可查看；描述性范围不产生伪项目。
4. 项目条目明确标记为“项目作用域”，并提示实际来源仍是统一 `MEMORY.md`。
5. 文件定位入口继续定位物理 `MEMORY.md`；解析和查看全程不修改该文件。
