#!/usr/bin/env node
import { Command } from 'commander'
import { runInit } from './commands/init.js'
import { runStatus } from './commands/status.js'
import { runScanCommand } from './commands/scan.js'
import { runSessionsShow } from './commands/sessions.js'
import { runRulesList, runRulesShow } from './commands/rules.js'
import {
  runProjectsAssign,
  runProjectsList,
  runProjectsMerge,
  runProjectsReclassify,
  runProjectsSessions,
} from './commands/projects.js'
import { WORKSPACE_ENV } from './workspace.js'

const program = new Command()

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
  .action(async (sessionId: string) => {
    await runSessionsShow(sessionId)
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
