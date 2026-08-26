# Agent Memory 项目浏览实施计划

## 设计对齐

- 以已确认的 `docs/prototypes/agent-memory-project-browser.html` 为视觉和交互基线。
- 页面采用 `PageShell collection + wide + compact`，默认进入「按项目」，保留「全部来源」。
- 项目列表只负责定位，点击后进入独立详情，不使用常驻列表详情分栏。
- 项目汇总只是只读归组，不生成合并文件，不改变现有读取和文件定位安全边界。

## 数据规则

- Codex 项目路径继续来自 `applies_to.cwd`，不改变现有项目切片逻辑。
- Claude 项目路径只从 Memory 同级项目目录内 Session JSONL 的顶层 `cwd` 元数据提取。
- Claude 最近 Session 只出现一个规范化绝对 cwd 时写入 `source.projectPath`；没有证据或出现多个 cwd 时保持未关联。
- 不反解 Claude 编码目录名，不读取或保存消息正文，不产生 DB、缓存或 Memory 副本。
- Renderer 按规范化后的 `projectPath` 分组，同名不同路径保持独立。

## 执行顺序与观察点

1. Core 增加 Claude cwd 发现逻辑和测试。
   - 观察：单 cwd 能关联，多 cwd 保持未关联，既有读取和发布 id 不变。
2. Renderer 增加项目归组纯函数和测试。
   - 观察：全局来源不进入项目列表，同路径 Claude/Codex 合并，排序稳定。
3. 重构 Agent Memory 索引页。
   - 观察：默认按项目、视图切换、搜索、Agent 筛选、待关联和来源分组。
4. 重构详情页为项目级来源汇总。
   - 观察：汇总、Claude、Codex tab；每个来源保留路径、匹配条件、只读状态和文件定位。
5. 运行测试、构建和真实 Electron 视觉验收。
   - 观察：桌面首屏、全部来源、项目详情、窄窗口、浅色和深色模式。

## 验证方式

- Core：`npm test -w @memory-manager/core -- --runInBand test/unit/auto-memories.test.ts`
- App：项目归组单元测试与 `home-workflow-layout.test.ts`
- 全量：Core/App `npm test`、Core/App production build、`git diff --check`
- 视觉：真实 Electron 截图对比 HTML 原型，确认页面层级、密度和无横向溢出。

## 验收标准

- 默认项目视图能按真实路径合并 Claude 与 Codex Memory。
- 全部来源视图区分 Claude 物理文件、Codex 本机文件和 Codex 派生项目范围。
- 搜索和 Agent 筛选正确，空状态、错误状态和 Claude 待关联状态完整。
- 项目详情可以按来源切换，且所有内容保留真实来源边界。
- 不新增任何 Memory 写入行为，既有单来源读取和文件定位继续可用。
- 自动化测试、构建和真实 Electron 截图验收通过。
