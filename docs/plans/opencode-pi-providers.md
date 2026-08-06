# OpenCode / Pi 原生 Provider 落地计划

## 范围

- OpenCode 接入设置、普通 Chat 与规则生成；Pi 接入设置与普通 Chat，禁止进入规则生成。
- Provider 行为以本机 Paseo direct adapter 为参考：OpenCode 使用本地 HTTP/SSE server，Pi 使用 `pi --mode rpc` JSONL RPC。
- 扩展 Provider 目录、thinking options、权限问题交互与 provider-neutral persistence handle；兼容现有 Claude/Codex Chat 数据。
- 保持 Full Access 与 Tool output 不落 ChatStore 的既有策略；Pi 不直接删除原生 JSONL Session。

## 观察点与验证方式

1. **Provider 合同**
   - 观察：四 Provider 可配置；模型声明结构化输出、thinking 与 Fast 能力；旧 version 2 Chat 可继续读取。
   - 验证：Core config/catalog 与 App ChatStore、Rules/Chat view-model 红绿测试；Pi 在 Rules 入口计数为 0。
2. **OpenCode runtime**
   - 观察：共享 `opencode serve` 有 ready、引用计数和清理；SSE 只消费目标 Session；prompt ack 不被当作完成。
   - 验证：假 server 覆盖创建/恢复/断流/串 Session/中断/问题/结构化输出/清理；本机三轮与规则生成 smoke。
3. **Pi runtime**
   - 观察：JSONL 请求关联、超时、非法行、进程退出与树清理可靠；恢复使用 session file；问题请求可回答。
   - 验证：假进程覆盖分片/乱序/超时/退出/恢复/Tool/问题；本机三轮与重启恢复 smoke。
   - 实现边界：Chat 与模型 probe 复用 `jsonl-rpc-process.ts`；真实子进程使用独立进程组，关闭按 SIGTERM→SIGKILL，原生 session file 不删除。
4. **UI 与数据边界**
   - 观察：设置与 Chat 根据 capability 展示模型、thinking、Fast；问题卡不静默处理；Tool output 不新增持久化。
   - 验证：IPC、i18n、布局与隐私测试，Electron 暗/亮主题手工验收，ChatStore 文件回读。

## 最终验收

- `npm test -- --runInBand`：不少于 30 suites / 309 tests，0 skipped。
- `npm test -w @memory-manager/app -- --runInBand`：不少于 34 suites / 216 tests，0 skipped。
- `npm run build`、`npm run build -w @memory-manager/app`、`git diff --check` 通过。
- OpenCode/Pi 各三轮真实 Chat 且 runtime 重启后恢复相同原生 Session；OpenCode 真实结构化规则生成成功；Pi 不出现在 Rules。
- 真实 question 不能由假进程替代：OpenCode 使用原生 question tool；Pi 使用仓库外临时 extension 触发 RPC UI，验收后删除临时文件。

## OpenCode 可用模型目录修复（2026-08-06）

- 观察：`provider.list().all` 是全量模型目录，不等于本机可用模型；Paseo 仅接受 `connected` Provider 或
  `source === "api"` Provider，并向 `provider.list` 传入当前目录。
- 验证：行为测试必须排除未连接的 config Provider、保留 connected 与 api Provider；无可访问 Provider 时
  明确报错。真实 probe 数量必须与 `opencode models` 一致，随后运行 Core/App 全量测试、两项 build 与
  `git diff --check`。
