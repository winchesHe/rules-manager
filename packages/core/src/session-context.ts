import Database from 'better-sqlite3'
import { getDbPath, isDatabaseReady } from './db.js'
import type { AgentName, SessionStatus } from './types.js'

export interface SessionContextQuery {
  homeDir?: string
  project?: string | 'all'
  from?: string
  to?: string
  cursor?: string
  limit?: number
}

export interface SessionContextItem {
  id: string
  agent: AgentName
  slug: string
  updatedAt: string
  status: SessionStatus
  sourceAvailable: boolean
}

export interface SessionContextPage {
  items: SessionContextItem[]
  nextCursor: string | null
}

export interface SessionContextReference {
  id: string
  agent: string
}

interface SessionContextRow {
  id: string
  agent: AgentName
  slug: string
  updated_at: string
  status: SessionStatus
}

interface DecodedCursor {
  updatedAt: string
  id: string
}

export function querySessionContext(input: SessionContextQuery = {}): SessionContextPage {
  if (!isDatabaseReady(input.homeDir)) return { items: [], nextCursor: null }
  const project = input.project ?? 'all'
  if (!project.trim()) throw new Error('session context project is required')
  const from = optionalIso(input.from, 'from')
  const to = optionalIso(input.to, 'to')
  if (from && to && from > to) throw new Error('session context from must not exceed to')
  const cursor = input.cursor ? decodeCursor(input.cursor) : null
  const limit = input.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('session context limit must be between 1 and 200')
  }

  const conditions: string[] = []
  const params: Record<string, unknown> = { fetchLimit: limit + 1 }
  if (project !== 'all') {
    conditions.push('slug = @project')
    params.project = project
  }
  if (from) {
    conditions.push('updated_at >= @from')
    params.from = from
  }
  if (to) {
    conditions.push('updated_at <= @to')
    params.to = to
  }
  if (cursor) {
    conditions.push('(updated_at < @cursorUpdatedAt OR (updated_at = @cursorUpdatedAt AND id < @cursorId))')
    params.cursorUpdatedAt = cursor.updatedAt
    params.cursorId = cursor.id
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const db = new Database(getDbPath(input.homeDir), { readonly: true })
  try {
    const rows = db.prepare(`
      SELECT id, agent, slug, updated_at, status
      FROM sessions
      ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT @fetchLimit
    `).all(params) as SessionContextRow[]
    const hasMore = rows.length > limit
    const visible = rows.slice(0, limit)
    const last = visible.at(-1)
    return {
      items: visible.map(mapRow),
      nextCursor: hasMore && last
        ? encodeCursor({ updatedAt: last.updated_at, id: last.id })
        : null,
    }
  } finally {
    db.close()
  }
}

export function resolveSessionContextItems(
  references: SessionContextReference[],
  homeDir?: string,
): SessionContextItem[] {
  if (references.length === 0) return []
  if (references.length > 500) throw new Error('too many session context references')
  if (!isDatabaseReady(homeDir)) return references.map(missingReference)
  const ids = [...new Set(references.map((reference) => reference.id))]
  const placeholders = ids.map(() => '?').join(', ')
  const db = new Database(getDbPath(homeDir), { readonly: true })
  try {
    const rows = db.prepare(`
      SELECT id, agent, slug, updated_at, status
      FROM sessions
      WHERE id IN (${placeholders})
    `).all(...ids) as SessionContextRow[]
    const byKey = new Map(rows.map((row) => [`${row.agent}\0${row.id}`, row]))
    return references.map((reference) => {
      const row = byKey.get(`${reference.agent}\0${reference.id}`)
      return row ? mapRow(row) : missingReference(reference)
    })
  } finally {
    db.close()
  }
}

function mapRow(row: SessionContextRow): SessionContextItem {
  return {
    id: row.id,
    agent: row.agent,
    slug: row.slug,
    updatedAt: row.updated_at,
    status: row.status,
    sourceAvailable: row.status !== 'missing' && row.status !== 'error',
  }
}

function missingReference(reference: SessionContextReference): SessionContextItem {
  return {
    id: reference.id,
    agent: reference.agent as AgentName,
    slug: 'unknown',
    updatedAt: '',
    status: 'missing',
    sourceAvailable: false,
  }
}

function optionalIso(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined
  if (!value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error(`session context ${label} must be an ISO timestamp`)
  }
  return new Date(value).toISOString()
}

function encodeCursor(cursor: DecodedCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string): DecodedCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    const cursor = parsed as Partial<DecodedCursor>
    if (typeof cursor.updatedAt !== 'string' || typeof cursor.id !== 'string' || !cursor.id) {
      throw new Error()
    }
    return { updatedAt: cursor.updatedAt, id: cursor.id }
  } catch {
    throw new Error('session context cursor is invalid')
  }
}
