import fs from 'node:fs'
import path from 'node:path'
import type { AgentAdapter, DiscoveredSession, ScanOptions, ScanSummary } from './types.js'
import { ALL_ADAPTERS, getAdapters } from './adapters/index.js'
import { initDatabase } from './db.js'
import { resolveWorkspace } from './workspace.js'

interface SessionRow {
  id: string
  updated_at: string
  content_hash: string
}

function determineScanState(
  discovered: DiscoveredSession,
  existing: SessionRow | undefined,
): 'new' | 'updated' | 'unchanged' {
  if (!existing) return 'new'
  if (existing.updated_at !== discovered.updatedAt || existing.content_hash !== discovered.contentHash) {
    return 'updated'
  }
  return 'unchanged'
}

export async function runScan(opts: ScanOptions): Promise<ScanSummary> {
  resolveWorkspace(opts.homeDir) // validate paths
  const db = initDatabase(opts.homeDir)
  const now = new Date().toISOString()

  const adapters: AgentAdapter[] = opts.all
    ? ALL_ADAPTERS
    : getAdapters(opts.agents ?? [])

  const sourceBase = opts.source
    ? path.resolve(opts.source)
    : path.join(process.env.HOME ?? '', '.config', 'memory-manager', 'sources')

  const summary: ScanSummary = {
    total: 0,
    new: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    errors: 0,
  }

  const getSession = db.prepare('SELECT id, updated_at, content_hash FROM sessions WHERE id = ?')

  const insertSession = db.prepare(`
    INSERT INTO sessions
      (id, agent, source_path, source_kind, updated_at, content_hash,
       scan_state, first_seen_at, last_seen_at)
    VALUES
      (@id, @agent, @source_path, @source_kind, @updated_at, @content_hash,
       @scan_state, @first_seen_at, @last_seen_at)
  `)

  const updateSession = db.prepare(`
    UPDATE sessions SET
      source_path   = @source_path,
      source_kind   = @source_kind,
      updated_at    = @updated_at,
      content_hash  = @content_hash,
      scan_state    = @scan_state,
      last_seen_at  = @last_seen_at
    WHERE id = @id
  `)

  const scannedAgents = new Set<string>(adapters.map((a) => a.name))
  const discoveredIds = new Set<string>()

  for (const adapter of adapters) {
    const agentSourceDir = path.join(sourceBase, adapter.name)
    if (!fs.existsSync(agentSourceDir)) continue

    let sessions: DiscoveredSession[]
    try {
      sessions = await adapter.discover(agentSourceDir)
    } catch {
      summary.errors++
      continue
    }

    for (const session of sessions) {
      discoveredIds.add(session.id)
      summary.total++

      try {
        const existing = getSession.get(session.id) as SessionRow | undefined
        const state = determineScanState(session, existing)

        if (!existing) {
          insertSession.run({
            id: session.id,
            agent: session.agent,
            source_path: session.sourcePath,
            source_kind: session.sourceKind,
            updated_at: session.updatedAt,
            content_hash: session.contentHash,
            scan_state: state,
            first_seen_at: now,
            last_seen_at: now,
          })
          summary.new++
        } else {
          updateSession.run({
            id: session.id,
            source_path: session.sourcePath,
            source_kind: session.sourceKind,
            updated_at: session.updatedAt,
            content_hash: session.contentHash,
            scan_state: state,
            last_seen_at: now,
          })
          if (state === 'updated') summary.updated++
          else summary.unchanged++
        }
      } catch {
        summary.errors++
      }
    }
  }

  // Mark sessions that were in DB but not found in this scan as missing
  const allRows = db
    .prepare('SELECT id, agent FROM sessions')
    .all() as Array<{ id: string; agent: string }>

  for (const row of allRows) {
    if (scannedAgents.has(row.agent) && !discoveredIds.has(row.id)) {
      db.prepare("UPDATE sessions SET scan_state = 'missing' WHERE id = ?").run(row.id)
      summary.missing++
    }
  }

  db.close()
  return summary
}
