import * as clack from '@clack/prompts'
import pc from 'picocolors'
import type { AgentName, ScanOptions } from '../types.js'
import { ALL_ADAPTERS } from '../adapters/index.js'
import { runScan } from '../scanner.js'
import { workspaceExists } from '../workspace.js'

export interface ScanCommandOptions {
  source?: string
  all?: boolean
  agent?: string   // comma-separated agent names
  full?: boolean
  homeDir?: string
}

export async function runScanCommand(opts: ScanCommandOptions): Promise<void> {
  if (!workspaceExists(opts.homeDir)) {
    console.error(pc.red('✗') + ' 工作区未初始化，请先运行 memory-manager init')
    process.exit(1)
  }

  let all = opts.all ?? false
  let agents: AgentName[] | undefined

  if (opts.agent) {
    agents = opts.agent.split(',').map((s) => s.trim() as AgentName)
  }

  const isInteractive = !all && !agents

  if (isInteractive) {
    clack.intro(pc.cyan('memory-manager scan'))

    const options = [
      ...ALL_ADAPTERS.map((a) => ({ value: a.name as string, label: a.name })),
      { value: 'all', label: 'all（扫描所有 agents）' },
    ]

    const selection = await clack.select({ message: '选择要扫描的 agent', options })

    if (clack.isCancel(selection)) {
      clack.outro(pc.yellow('已取消'))
      process.exit(0)
    }

    if (selection === 'all') {
      all = true
    } else {
      agents = [selection as AgentName]
    }
  }

  const scanOpts: ScanOptions = {
    source: opts.source,
    all,
    agents,
    full: opts.full,
    homeDir: opts.homeDir,
  }

  const spinner = clack.spinner()
  spinner.start('扫描中…')

  try {
    const summary = await runScan(scanOpts)
    spinner.stop('扫描完成')

    console.log(`Sessions: ${summary.total} total`)
    console.log(`New: ${summary.new}`)
    if (summary.updated > 0) console.log(`Updated: ${summary.updated}`)
    if (summary.unchanged > 0) console.log(`Unchanged: ${summary.unchanged}`)
    if (summary.missing > 0) console.log(`Missing: ${summary.missing}`)
    console.log(`Errors: ${summary.errors}`)
  } catch (err) {
    spinner.stop('扫描失败')
    throw err
  }
}
