#!/usr/bin/env node
import { Command } from 'commander'
import { runInit } from './commands/init.js'
import { runStatus } from './commands/status.js'
import { runScanCommand } from './commands/scan.js'

const program = new Command()

program
  .name('memory-manager')
  .description('本地优先 AI agent session 管理与 rules 生成 CLI')
  .version('0.1.0')

program
  .command('init')
  .description('初始化 ~/.memory-manager 工作区')
  .option('--yes', '非交互模式，跳过确认直接执行', false)
  .action(async (opts: { yes: boolean }) => {
    await runInit({ yes: opts.yes })
  })

program
  .command('status')
  .description('显示工作区状态')
  .action(() => {
    runStatus()
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

export async function runCli(argv: string[]): Promise<void> {
  await program.parseAsync(argv)
}

runCli(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`error: ${message}`)
  process.exit(1)
})
