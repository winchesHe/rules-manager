import fs from 'node:fs'
import Database from 'better-sqlite3'
import type { AgentAdapter, AgentName, DiscoveredSession } from './types.js'
import { resolveWorkspace } from './workspace.js'
import { getDbPath, initDatabase, isDatabaseReady } from './db.js'
import { listLinks, linkSession, moveLink } from './fs-writer.js'
import { classify } from './classifier.js'
import { ALL_ADAPTERS } from './adapters/index.js'

export interface ProjectListItem {
  slug: string
  sessionCount: number
  agents: string[]
}

export interface ProjectListOptions {
  homeDir?: string
}

// ─── listProjects（FS 真理 + DB 反查 agent） ─────────────────────────────────

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
    items.sort((a, b) => {
      if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount
      return a.slug.localeCompare(b.slug)
    })
    return items
  } finally {
    db.close()
  }
}

// ─── assignSession（人工修正归类） ──────────────────────────────────────────

export interface AssignResult {
  previousSlug: string
  newSlug: string
}

export function assignSession(
  sessionId: string,
  slug: string,
  opts: ProjectListOptions = {},
): AssignResult {
  if (!sessionId) throw new Error('assignSession: sessionId required')
  if (!isDatabaseReady(opts.homeDir)) {
    throw new Error('assignSession: workspace not initialized')
  }
  const { workspaceDir } = resolveWorkspace(opts.homeDir)
  const db = initDatabase(opts.homeDir)
  try {
    const row = db
      .prepare('SELECT id, slug, source_path FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; slug: string; source_path: string } | undefined
    if (!row) throw new Error(`assignSession: session not found: ${sessionId}`)

    if (row.slug === slug) {
      return { previousSlug: row.slug, newSlug: slug }
    }

    // FS：尝试 moveLink；若旧 link 不存在则建新（容错）
    try {
      moveLink(workspaceDir, sessionId, row.slug, slug)
    } catch {
      // 旧 link 缺失 → 直接建新
      linkSession(workspaceDir, slug, sessionId, row.source_path)
    }

    // DB
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE sessions SET slug = ?, classified_at = ?, last_seen_at = ? WHERE id = ?',
    ).run(slug, now, now, sessionId)

    return { previousSlug: row.slug, newSlug: slug }
  } finally {
    db.close()
  }
}

// ─── mergeProjects（FS mv 目录全部 + DB 批量 UPDATE） ───────────────────────

export interface MergeResult {
  sessionsMoved: number
}

export function mergeProjects(
  from: string,
  to: string,
  opts: ProjectListOptions = {},
): MergeResult {
  if (!isDatabaseReady(opts.homeDir)) {
    throw new Error('mergeProjects: workspace not initialized')
  }
  if (from === to) return { sessionsMoved: 0 }

  const { workspaceDir } = resolveWorkspace(opts.homeDir)
  const links = listLinks(workspaceDir)
  const fromSids = links.get(from) ?? []
  if (fromSids.length === 0) {
    throw new Error(`mergeProjects: no sessions belong to project: ${from}`)
  }

  const db = initDatabase(opts.homeDir)
  const now = new Date().toISOString()
  const update = db.prepare(
    'UPDATE sessions SET slug = ?, classified_at = ?, last_seen_at = ? WHERE id = ?',
  )

  try {
    let moved = 0
    for (const sid of fromSids) {
      try {
        moveLink(workspaceDir, sid, from, to)
        update.run(to, now, now, sid)
        moved++
      } catch (err) {
        // 单 link 失败不阻断整体；记日志（FS 视图最终 reconcile）
        console.error(
          `[merge] session ${sid} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return { sessionsMoved: moved }
  } finally {
    db.close()
  }
}

// ─── reclassifyAll（重读 jsonl 抽 hints + classify + 必要时 mv） ────────────

export interface ReclassifyResult {
  total: number
  changed: number
  unchanged: number
  skipped: number
}

export async function reclassifyAll(
  opts: ProjectListOptions & { full?: boolean } = {},
): Promise<ReclassifyResult> {
  if (!isDatabaseReady(opts.homeDir)) {
    throw new Error('reclassifyAll: workspace not initialized')
  }
  const { workspaceDir } = resolveWorkspace(opts.homeDir)
  const db = initDatabase(opts.homeDir)
  const now = new Date().toISOString()
  const update = db.prepare(
    'UPDATE sessions SET slug = ?, classified_at = ?, last_seen_at = ? WHERE id = ?',
  )

  const adapterByName = new Map<AgentName, AgentAdapter>(
    ALL_ADAPTERS.map((a) => [a.name, a]),
  )

  try {
    const rows = db
      .prepare(
        "SELECT id, agent, source_path, slug, content_hash, updated_at FROM sessions " +
          "WHERE status != 'missing' AND status != 'error'",
      )
      .all() as Array<{
      id: string
      agent: AgentName
      source_path: string
      slug: string
      content_hash: string
      updated_at: string
    }>

    let changed = 0
    let unchanged = 0
    let skipped = 0

    for (const row of rows) {
      if (!fs.existsSync(row.source_path)) {
        skipped++
        continue
      }
      const adapter = adapterByName.get(row.agent)
      if (!adapter) {
        skipped++
        continue
      }

      const fakeDiscovered: DiscoveredSession = {
        id: row.id,
        agent: row.agent,
        sourcePath: row.source_path,
        sourceKind: 'jsonl',
        updatedAt: row.updated_at,
        contentHash: row.content_hash,
      }

      let newSlug: string
      try {
        const hints = await adapter.extractProjectHints(fakeDiscovered)
        newSlug = classify(hints)
      } catch {
        skipped++
        continue
      }

      if (newSlug === row.slug) {
        unchanged++
        continue
      }

      try {
        moveLink(workspaceDir, row.id, row.slug, newSlug)
      } catch {
        // FS 失败仅记日志；DB 仍按新 slug 写
      }
      update.run(newSlug, now, now, row.id)
      changed++
    }

    return { total: rows.length, changed, unchanged, skipped }
  } finally {
    db.close()
  }
}
