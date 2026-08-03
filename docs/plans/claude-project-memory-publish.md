# Claude 项目 Memory 发布

## 范围与安全边界

- 发布页允许选择一个项目、勾选该项目的 accepted project rules，并选择一个已发现的 Claude 项目
  Auto Memory。
- 不从 `project_slug` 猜 Claude 的不透明项目目录；目标必须由用户显式选择。
- 只支持 Claude project `memory/MEMORY.md`；Codex 当前没有公开稳定的项目级 Memory 映射。
- `MEMORY.md` 只新增或替换 Memory Manager 受管区块，其他内容保持字节级不变；完整规则写入固定
  `memory-manager-rules.md` topic。
- Memory 与 topic 均使用预览 revision 做冲突检测，写入使用同目录临时文件 + fsync + rename。
- 拒绝非 accepted、非 project、跨项目混选、未知 target、不完整 marker、超限受管块及最终文件
  symlink。

## 观察点与验证方式

1. Core：首次发布、重复发布、更新受管块、保留 Claude 内容、Memory/topic 冲突、非法规则集合。
2. App：项目选择、规则多选、Memory 目标选择、发布结果及 IPC 参数校验。
3. 真实 Electron：选择项目规则和 Claude Memory，确认发布前无默认选择；使用本机目标时只验证预览和
   控件，不在验收中实际写入用户 Memory。
4. Core/App 全量测试、production build 与 `git diff --check`。

