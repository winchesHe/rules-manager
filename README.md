# memory-manager

一个本地优先的 AI Agent Session 管理工具。它扫描本机多个编码 Agent 的历史会话，按项目聚合，提供可审计的上下文检索，并从真实使用证据中生成可人工审核的长期规则。

项目同时提供命令行工具和 Electron 桌面端，目前主要在 macOS 上开发与验证。

## 核心能力

- 扫描 Claude、Codex、GitHub Copilot、Cursor、OpenCode 和 Pi 的本地 Session。
- 根据 `cwd`、Git 根目录、分支和来源路径，把 Session 归入项目。
- 通过文件系统项目视图浏览分类结果，并支持分配、合并和重新分类。
- 按条件查询最近 Session，定位证据后实时回源读取最新上下文。
- 使用 Claude、Codex、OpenCode 或 Pi 生成规则候选，保留证据引用并经过人工接受或拒绝。
- 将已接受规则发布到项目规则文件，以及受支持 Agent 的项目记忆或指令入口。
- 在桌面端浏览项目、Session、规则、生成任务和 Agent Memory。

## 本地优先与隐私

memory-manager 不把对话正文、工具输出或 LLM Prompt 存进自己的数据库。数据库只保存内容指纹、项目元数据、状态和原始 Session 路径引用。

需要展示或分析上下文时，工具会从本机 Agent 的权威数据源实时读取。Context 查询清单只保存选择结果、覆盖情况和证据定位信息，不持久化对话正文。

> 使用前请确认你有权读取对应 Agent Session。不要提交个人工作区、数据库、运行日志或真实 Session fixture。

## 支持的数据源

| Agent | 主要数据源 |
|---|---|
| Claude | JSONL |
| Codex | JSONL |
| GitHub Copilot | JSONL / YAML |
| Cursor | JSONL |
| OpenCode | SQLite |
| Pi | JSONL |

## 快速开始

需要 Node.js 和 npm。克隆仓库后安装依赖并构建 CLI：

```bash
npm install
npm run build
node packages/core/dist/cli.js --help
```

初始化默认工作区并扫描本机数据源：

```bash
node packages/core/dist/cli.js init --non-interactive
node packages/core/dist/cli.js scan --all
node packages/core/dist/cli.js projects list
```

默认数据目录是 `~/.memory-manager/`。也可以通过全局 `--workspace <path>` 指定其他位置。

如果希望直接使用 `memory-manager` 命令，可在构建后链接 Core 包：

```bash
cd packages/core
npm link
memory-manager --help
```

## 常用命令

```text
memory-manager init
memory-manager status
memory-manager scan
memory-manager sessions show <session-id>
memory-manager projects list
memory-manager projects sessions [slug]
memory-manager projects assign <session-id> <slug>
memory-manager projects merge <from> <to>
memory-manager projects reclassify
memory-manager context <command>
memory-manager rules <command>
```

使用 `memory-manager <command> --help` 查看完整参数。

## 桌面端

启动开发环境：

```bash
npm run dev -w @memory-manager/app
```

构建桌面端：

```bash
npm run build -w @memory-manager/app
```

桌面端提供 Overview、Projects、Rules、Chat 和 Settings 等工作区，底层仍复用 Core 的本地扫描、分类和规则能力。

## 开发与验证

```bash
# Core 测试与构建
npm test -w @memory-manager/core
npm run build -w @memory-manager/core

# Electron App 测试与构建
npm test -w @memory-manager/app
npm run build -w @memory-manager/app
```

仓库中的 `packages/core/test/sources/` 是最小合成 fixture，只保留各 Agent 格式解析和分类所需字段，不包含真实对话或公司代码。

## 项目结构

```text
packages/core/   CLI、adapter、扫描、分类、Context 与规则生成
packages/app/    Electron 主进程、Renderer 和桌面端测试
packages/evals/  Session Evidence 评估工具与脱敏基准
docs/specs/      关键功能规格
docs/plans/      实施计划与验证记录
```

## 当前状态

项目仍处于早期开发阶段，数据格式和命令接口可能调整。执行真实扫描前，建议先使用独立 `--workspace` 验证数据源和输出。
