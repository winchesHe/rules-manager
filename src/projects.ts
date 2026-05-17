import Database from 'better-sqlite3'
import { resolveWorkspace } from './workspace.js'
import { getDbPath, isDatabaseReady } from './db.js'
import { listLinks } from './fs-writer.js'

/**
 * 从 FS 读 projects/<slug>/ 视图 + DB 反查 agent 集合。
 * 数据真理是 FS（symlink 文件存在即归属）；DB 仅用来反查 agent 集合。
 */
export interface ProjectListItem {
  slug: string
  sessionCount: number
  agents: string[]
}

export interface ProjectListOptions {
  homeDir?: string
}

export function listProjects(opts: ProjectListOptions = {}): ProjectListItem[] {
  const { workspaceDir } = resolveWorkspace(opts.homeDir)
  if (!isDatabaseReady(opts.homeDir)) return []

  const links = listLinks(workspaceDir)
  if (links.size === 0) return []

  const db = new Database(getDbPath(opts.homeDir), { readonly: true })
  try {
    const stmt = db.prepare('SELECT DISTINCT agent FROM sessions WHERE slug = ?')

    const items: ProjectListItem[] = []
    for (const [slug, sessionIds] of links) {
      const rows = stmt.all(slug) as Array<{ agent: string }>
      items.push({
        slug,
        sessionCount: sessionIds.length,
        agents: rows.map((r) => r.agent).sort(),
      })
    }
    // 排序：session 多的在前；同数按 slug 字典序
    items.sort((a, b) => {
      if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount
      return a.slug.localeCompare(b.slug)
    })
    return items
  } finally {
    db.close()
  }
}

/**
 * assign / merge / reclassify 在 plan 步 5-6 实现。
 * 这里留 stub 让 commands/projects.ts 能 build。
 */
export function assignSession(
  _sessionId: string,
  _slug: string,
  _opts: ProjectListOptions = {},
): never {
  throw new Error('assignSession: not implemented yet (plan 步 5)')
}

export function mergeProjects(
  _from: string,
  _to: string,
  _opts: ProjectListOptions = {},
): never {
  throw new Error('mergeProjects: not implemented yet (plan 步 5)')
}

export function reclassifyAll(_opts: ProjectListOptions & { full?: boolean } = {}): never {
  throw new Error('reclassifyAll: not implemented yet (plan 步 6)')
}
