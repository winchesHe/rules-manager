import pc from 'picocolors'
import { isDatabaseReady } from '../db.js'
import {
  assignSession,
  listProjects,
  mergeProjects,
  reclassifyAll,
} from '../projects.js'

// Re-export 给老 import 路径用（test/unit/projects.test.ts）
export { listProjects } from '../projects.js'
export type { ProjectListItem, ProjectsHomeOptions } from '../projects.js'

interface CommandOptions {
  homeDir?: string
}

function ensureWorkspace(homeDir?: string): void {
  if (!isDatabaseReady(homeDir)) {
    console.error(pc.red('✗') + ' 工作区未初始化，请先运行 memory-manager init')
    process.exit(1)
  }
}

export function runProjectsList(opts: CommandOptions = {}): void {
  ensureWorkspace(opts.homeDir)
  const items = listProjects(opts)
  if (items.length === 0) {
    console.log(pc.dim('（暂无项目；请先运行 memory-manager scan）'))
    return
  }
  for (const item of items) {
    const conf = item.confidence.toFixed(2)
    const agents = item.agents.length ? item.agents.join(',') : '-'
    console.log(
      `${pc.cyan(item.projectKey.padEnd(28))}  ` +
        `confidence=${conf}  ` +
        `sessions=${item.sessionCount}  ` +
        `agents=${agents}`,
    )
  }
}

export function runProjectsAssign(
  sessionId: string,
  projectKey: string,
  opts: CommandOptions = {},
): void {
  ensureWorkspace(opts.homeDir)
  try {
    const r = assignSession(sessionId, projectKey, opts)
    const from = r.previousKey ?? pc.dim('(未分类)')
    console.log(
      `${pc.green('✓')} session ${pc.cyan(sessionId)} 归到 ${pc.cyan(projectKey)}（原 ${from}）`,
    )
  } catch (err) {
    console.error(pc.red('✗') + ' ' + (err instanceof Error ? err.message : String(err)))
    process.exit(1)
  }
}

export function runProjectsMerge(
  from: string,
  to: string,
  opts: CommandOptions = {},
): void {
  ensureWorkspace(opts.homeDir)
  try {
    const r = mergeProjects(from, to, opts)
    if (r.sessionsMoved === 0) {
      console.log(pc.dim('（from == to 或无 session 可移动，未做更改）'))
      return
    }
    console.log(
      `${pc.green('✓')} 合并 ${pc.cyan(from)} → ${pc.cyan(to)}：` +
        `${r.sessionsMoved} 个 session 已转移`,
    )
  } catch (err) {
    console.error(pc.red('✗') + ' ' + (err instanceof Error ? err.message : String(err)))
    process.exit(1)
  }
}

export function runProjectsReclassify(
  opts: CommandOptions & { full?: boolean } = {},
): void {
  ensureWorkspace(opts.homeDir)
  try {
    const r = reclassifyAll(opts)
    console.log(
      `${pc.green('✓')} 重分类完成：${r.total} 个 session，${r.changed} 个 project_key 变化`,
    )
  } catch (err) {
    console.error(pc.red('✗') + ' ' + (err instanceof Error ? err.message : String(err)))
    process.exit(1)
  }
}
