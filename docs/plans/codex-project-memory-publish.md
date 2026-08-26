# Codex 项目 Memory 发布

## 范围与契约

- 不直接编辑 Codex 生成态 `~/.codex/memories/MEMORY.md`。
- 仅在当前 Codex Memory 暴露 `extensions/ad_hoc/instructions.md` 契约时启用发布；契约不存在或变化时
  禁止写入。
- 项目作用域使用原始 Session metadata 中的 `git_root`（优先）或 `cwd`；不把项目 slug、Memory Manager
  的项目目录或 Chat 工作目录伪装成 Codex cwd。
- 同一项目存在多个 cwd 时全部列出，由用户显式选择；来源目录失效时保留为禁用目标。
- 每个 `project_slug + cwd` 维护一个固定的 Memory Manager ad-hoc note。note 只表达参考记忆，包含
  `applies_to: cwd=...`，不声明为必须执行的系统指令。
- note 使用 revision compare-and-swap、同目录原子替换；拒绝非受管同名文件、symlink、非法规则集合、
  保留 marker 和内容超限。

## 观察点与验证方式

1. Core：单 cwd、多 cwd、git root 优先、失效 cwd、契约缺失、首次发布、幂等、revision 冲突和非法规则。
2. App：选定项目后加载 Codex cwd，规则与 cwd 均显式选择，发布结果区分“已提交”和“无需更新”。
3. 真实 Electron：验证目标标签、禁用态和最终按钮启用，不在验收中写入本机 Codex Memory。
4. Core/App 全量测试、production build 与 `git diff --check`。
