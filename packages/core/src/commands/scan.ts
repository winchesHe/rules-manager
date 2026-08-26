import * as clack from '@clack/prompts'
import pc from 'picocolors'
import type {
  AgentName,
  ScanOptions,
  ScanProgress,
  ScanSummary,
} from '../types.js'
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

const SPINNER_FRAME_MS = 130

async function waitForSpinnerFrame(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, SPINNER_FRAME_MS))
}

export function formatScanSummary(summary: ScanSummary): string {
  return `新增 ${summary.new} · 更新 ${summary.updated} · 删除 ${summary.missing} · 错误 ${summary.errors}`
}

function progressMessage(progress: ScanProgress): string {
  switch (progress.phase) {
    case 'discovering':
      return `正在发现 ${progress.agent} sessions…`
    case 'processing':
      return `正在处理 ${progress.agent}：${progress.current ?? 0}/${progress.total ?? 0}`
    case 'done':
      return `${progress.agent} 完成：${progress.total ?? 0} sessions`
    case 'skipped':
      return `${progress.agent} 未找到数据源，已跳过`
    case 'error':
      return `${progress.agent} 扫描失败，继续下一个 agent`
  }
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

  const spinner = clack.spinner()
  spinner.start('准备扫描…')

  const scanOpts: ScanOptions = {
    source: opts.source,
    all,
    agents,
    full: opts.full,
    homeDir: opts.homeDir,
    onProgress: async (progress) => {
      spinner.message(progressMessage(progress))
      await waitForSpinnerFrame()
    },
  }

  try {
    const summary = await runScan(scanOpts)
    spinner.stop('扫描完成')

    clack.log.info(formatScanSummary(summary))
    clack.outro(summary.errors > 0 ? pc.yellow('扫描完成，存在错误') : pc.green('扫描成功'))
  } catch (err) {
    spinner.stop('扫描失败', 1)
    clack.outro(pc.red('扫描失败'))
    throw err
  }
}
