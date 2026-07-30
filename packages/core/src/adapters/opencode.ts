import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import type {
  AgentAdapter,
  DiscoveredSession,
  ParsedSession,
  ProjectHint,
} from '../types.js'
import { defaultNormalize } from './shared.js'

interface OpenCodeSessionRow {
  id: string
  directory: string
  title: string
  time_created: number
  time_updated: number
}

const metadataCache = new Map<string, OpenCodeSessionRow>()

function cacheKey(dbPath: string, sessionId: string): string {
  return `${dbPath}\0${sessionId}`
}

function openReadonly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true })
}

function readSessionRow(dbPath: string, sessionId: string): OpenCodeSessionRow | undefined {
  const key = cacheKey(dbPath, sessionId)
  const cached = metadataCache.get(key)
  if (cached) return cached

  const db = openReadonly(dbPath)
  try {
    const row = db
      .prepare(
        `SELECT id, directory, title, time_created, time_updated
         FROM session WHERE id = ?`,
      )
      .get(sessionId) as OpenCodeSessionRow | undefined
    if (row) metadataCache.set(key, row)
    return row
  } finally {
    db.close()
  }
}

function metadataHash(row: OpenCodeSessionRow): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([row.id, row.directory, row.title, row.time_created, row.time_updated]))
    .digest('hex')
}

function toIsoTimestamp(value: number): string {
  return new Date(value).toISOString()
}

function countMessages(dbPath: string, sessionId: string): number {
  const db = openReadonly(dbPath)
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'session_message')",
      )
      .all() as Array<{ name: string }>
    const available = new Set(tables.map(({ name }) => name))
    for (const name of ['message', 'session_message']) {
      if (!available.has(name)) continue
      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM ${name} WHERE session_id = ?`)
        .get(sessionId) as { count: number }
      if (row.count > 0) return row.count
    }
    return 0
  } finally {
    db.close()
  }
}

export const opencodeAdapter: AgentAdapter = {
  name: 'opencode',

  async probe(agentSourceDir: string) {
    const dbPath = path.join(agentSourceDir, 'opencode.db')
    if (!fs.existsSync(dbPath)) return { matched: false, reason: 'no opencode.db' }
    const db = openReadonly(dbPath)
    try {
      const row = db
        .prepare("SELECT 1 AS matched FROM sqlite_master WHERE type = 'table' AND name = 'session'")
        .get() as { matched: number } | undefined
      return row ? { matched: true } : { matched: false, reason: 'no session table' }
    } finally {
      db.close()
    }
  },

  async discover(agentSourceDir: string): Promise<DiscoveredSession[]> {
    const dbPath = path.join(agentSourceDir, 'opencode.db')
    if (!fs.existsSync(dbPath)) return []
    const cachePrefix = `${dbPath}\0`
    for (const key of metadataCache.keys()) {
      if (key.startsWith(cachePrefix)) metadataCache.delete(key)
    }
    const db = openReadonly(dbPath)
    try {
      const rows = db
        .prepare(
          `SELECT id, directory, title, time_created, time_updated
           FROM session
           WHERE parent_id IS NULL
           ORDER BY time_updated DESC`,
        )
        .all() as OpenCodeSessionRow[]
      return rows.map((row) => {
        metadataCache.set(cacheKey(dbPath, row.id), row)
        return {
          id: row.id,
          agent: 'opencode' as const,
          sourcePath: dbPath,
          sourceKind: 'sqlite',
          updatedAt: toIsoTimestamp(row.time_updated || row.time_created),
          contentHash: metadataHash(row),
        }
      })
    } finally {
      db.close()
    }
  },

  async parse(discovered: DiscoveredSession): Promise<ParsedSession> {
    const row = readSessionRow(discovered.sourcePath, discovered.id)
    const parsed: ParsedSession = {
      agent: 'opencode',
      sessionId: discovered.id,
      sourcePath: discovered.sourcePath,
      messageCount: fs.existsSync(discovered.sourcePath)
        ? countMessages(discovered.sourcePath, discovered.id)
        : 0,
      toolCallCount: 0,
      metadata: {},
    }
    if (!row) return parsed
    parsed.metadata.cwd = row.directory
    parsed.firstTimestamp = toIsoTimestamp(row.time_created)
    parsed.lastTimestamp = toIsoTimestamp(row.time_updated || row.time_created)
    return parsed
  },

  normalize: defaultNormalize,

  async extractProjectHints(discovered: DiscoveredSession): Promise<ProjectHint[]> {
    const row = readSessionRow(discovered.sourcePath, discovered.id)
    if (!row?.directory) return []
    return [{
      kind: 'cwd',
      value: row.directory,
      confidence: 0.9,
      agent: 'opencode',
      source: 'metadata',
      locator: 'session.directory',
    }]
  },
}
