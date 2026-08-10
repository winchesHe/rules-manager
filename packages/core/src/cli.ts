#!/usr/bin/env node
import { Command } from 'commander'
import { runInit } from './commands/init.js'
import { runStatus } from './commands/status.js'
import { runScanCommand } from './commands/scan.js'
import { runSessionsShow } from './commands/sessions.js'
import {
  runContextClose,
  runContextPrepare,
  runContextRead,
  runContextStatus,
} from './commands/context.js'
import { runRulesList, runRulesShow } from './commands/rules.js'
import { runRulesGenerate } from './commands/rules-generate.js'
import { runRulesOutput } from './commands/rules-output.js'
import {
  runRulesAccept,
  runRulesExplain,
  runRulesReject,
  runRulesReview,
} from './commands/rules-review.js'
import {
  runProjectsAssign,
  runProjectsList,
  runProjectsMerge,
  runProjectsReclassify,
  runProjectsSessions,
} from './commands/projects.js'
import { WORKSPACE_ENV } from './workspace.js'

const program = new Command()

async function runWithStdoutPipeGuard(action: () => Promise<void>): Promise<void> {
  let outputError: Error | undefined
  const onError = (error: Error) => {
    if (!('code' in error) || error.code !== 'EPIPE') outputError = error
  }

  process.stdout.on('error', onError)
  try {
    await action()
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (outputError) throw outputError
  } finally {
    process.stdout.off('error', onError)
  }
}

program
  .name('memory-manager')
  .description('本地优先 AI agent session 管理与 rules 生成 CLI')
  .version('0.1.0')
  .option('-w, --workspace <path>', '指定 .memory-manager 所在目录')
  .hook('preAction', (command) => {
    const workspace = command.opts().workspace as string | undefined
    if (workspace) process.env[WORKSPACE_ENV] = workspace
  })
  .action(() => {
    program.outputHelp()
  })

program
  .command('init')
  .description('初始化工作区')
  .option('--non-interactive', '跳过确认，直接执行', false)
  .action(async (opts: { nonInteractive: boolean }) => {
    await runInit({ nonInteractive: opts.nonInteractive })
  })

program
  .command('status')
  .description('显示工作区状态')
  .action(() => {
    runStatus()
  })

const sessions = program
  .command('sessions')
  .description('按需读取 session 数据')

sessions
  .command('show <session-id>')
  .description('读取 session 原文到 stdout（不落盘）')
  .option('--stream', '按 NDJSON 逐条流式输出，适用于大 Session', false)
  .action(async (sessionId: string, opts: { stream: boolean }) => {
    if (opts.stream) {
      await runWithStdoutPipeGuard(() => runSessionsShow(sessionId, { stream: true }))
      return
    }
    await runSessionsShow(sessionId)
  })

const context = program
  .command('context')
  .description('查询 Session 并提供可分页的完整上下文')

context
  .command('prepare')
  .description('执行 Session Query 并创建私有临时上下文')
  .option('--query-json <json>', '直接提供 Session Query JSON')
  .option('--query-file <path>', '从文件读取 Session Query JSON')
  .action(async (opts: { queryJson?: string; queryFile?: string }) => {
    await runContextPrepare(opts)
  })

context
  .command('read <run-id>')
  .description('读取一个 Session 的一个上下文分片（JSON）')
  .requiredOption('--session <session-id>', '目标 Session ID')
  .requiredOption('--part <n>', '从 1 开始的分片编号', (value: string) => Number(value))
  .action((runId: string, opts: { session: string; part: number }) => {
    runContextRead(runId, opts)
  })

context
  .command('status <run-id>')
  .description('查看 Context run 的 coverage 与分片状态')
  .action((runId: string) => {
    runContextStatus(runId)
  })

context
  .command('close <run-id>')
  .description('删除 Context run 的临时正文')
  .action((runId: string) => {
    runContextClose(runId)
  })

const rules = program
  .command('rules')
  .description('查看 agent 全局持久化指令')

rules
  .command('list [agent]')
  .description('列出全部或指定 agent 的全局指令来源（JSON）')
  .action((agent?: string) => {
    runRulesList(agent)
  })

rules
  .command('show <agent>')
  .description('读取指定 agent 的主要全局指令正文到 stdout（不落盘）')
  .action((agent: string) => {
    runRulesShow(agent)
  })

rules
  .command('generate')
  .description('从 session evidence 生成规则候选')
  .option('--dry-run', '输出候选但不写入数据库', false)
  .option('--project <slug>', '只处理指定项目')
  .option('--provider <provider>', 'LLM provider：claude 或 codex')
  .option('--model <model>', '覆盖配置中的模型')
  .option('--effort <effort>', '覆盖配置中的推理强度：low、medium、high、xhigh 或 max')
  .option('--rounds <n>', '每个 session 读取的最新对话轮数', (value: string) => Number(value))
  .option('--full', '读取完整 session 对话', false)
  .action(async (opts: {
    dryRun: boolean
    project?: string
    provider?: 'claude' | 'codex'
    model?: string
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    rounds?: number
    full: boolean
  }) => {
    if (opts.full && opts.rounds !== undefined) throw new Error('--full 与 --rounds 不能同时使用')
    await runRulesGenerate(opts)
  })

rules
  .command('review')
  .description('列出待人工审核的规则候选')
  .action(() => {
    runRulesReview()
  })

rules
  .command('accept <id>')
  .description('接受规则候选')
  .action((id: string) => {
    runRulesAccept(id)
  })

rules
  .command('reject <id>')
  .description('拒绝规则候选')
  .action((id: string) => {
    runRulesReject(id)
  })

rules
  .command('explain <id>')
  .description('展示规则候选的 evidence 与判断依据')
  .action((id: string) => {
    runRulesExplain(id)
  })

rules
  .command('output')
  .description('把已接受的规则候选输出为 Markdown 文件')
  .option('--project <slug>', '输出指定项目规则')
  .option('--global', '输出全局规则', false)
  .option('--style', '输出个人风格规则', false)
  .option('--all', '输出全部 scope', false)
  .option('--dry-run', '预览目标路径和内容但不写文件', false)
  .action((opts: {
    project?: string
    global: boolean
    style: boolean
    all: boolean
    dryRun: boolean
  }) => {
    runRulesOutput(opts)
  })

program
  .command('scan')
  .description('扫描 agent session 源并写入 DB')
  .option('--source <dir>', '指定源目录（包含各 agent 子目录）')
  .option('--all', '扫描所有内置 agents', false)
  .option('--agent <names>', '扫描指定 agents（逗号分隔，如 claude,codex）')
  .option('--full', '完整重扫（忽略缓存状态）', false)
  .action(async (opts: { source?: string; all: boolean; agent?: string; full: boolean }) => {
    await runScanCommand(opts)
  })

const projects = program
  .command('projects')
  .description('项目归类管理')

projects
  .command('list')
  .description('列出当前项目归类（含 confidence 与 session 数）')
  .action(() => {
    runProjectsList()
  })

projects
  .command('sessions [slug]')
  .description('列出全部或指定项目的 session metadata（JSON）')
  .action((slug?: string) => {
    runProjectsSessions(slug)
  })

projects
  .command('assign <session-id> <project-key>')
  .description('把指定 session 归到目标项目（人工修正，confidence=1.0）')
  .action((sessionId: string, projectKey: string) => {
    runProjectsAssign(sessionId, projectKey)
  })

projects
  .command('merge <from> <to>')
  .description('把 from 项目下所有 session/hint 转到 to 项目')
  .action((from: string, to: string) => {
    runProjectsMerge(from, to)
  })

projects
  .command('reclassify')
  .description('基于现有 hints 重新跑 classifier 全量重算项目归类')
  .option('--full', '全量重算（当前等价默认；预留人工标记忽略语义）', false)
  .action(async (opts: { full?: boolean }) => {
    await runProjectsReclassify(opts)
  })

export async function runCli(argv: string[]): Promise<void> {
  await program.parseAsync(argv)
}

runCli(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`error: ${message}`)
  process.exit(1)
})
