import { antigravityTitle } from './antigravity-source.js'
import { t3Title } from './t3-source.js'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { getDbPath, isDatabaseReady } from './db.js'
import type { AgentName, SessionStatus } from './types.js'
import { redactSecrets } from './redaction.js'
import { grokSessionTitle } from './grok-session.js'

export interface SessionContextQuery {
  homeDir?: string
  project?: string | 'all'
  from?: string
  to?: string
  cursor?: string
  limit?: number
  exclude?: SessionContextReference[]
}

export interface SessionContextItem {
  id: string
  agent: AgentName
  displayName: string
  slug: string
  updatedAt: string
  status: SessionStatus
  sourceAvailable: boolean
}

export interface SessionContextPage {
  items: SessionContextItem[]
  nextCursor: string | null
  references: SessionContextReference[]
}

export interface SessionContextReference {
  id: string
  agent: string
}

interface SessionContextRow {
  id: string
  agent: AgentName
  source_path: string
  slug: string
  updated_at: string
  status: SessionStatus
}

export interface SessionDisplayNameSource {
  id: string
  agent: AgentName
  sourcePath: string
  slug: string
}

interface DecodedCursor {
  updatedAt: string
  id: string
}

export function querySessionContext(input: SessionContextQuery = {}): SessionContextPage {
  if (!isDatabaseReady(input.homeDir)) {
    return { items: [], nextCursor: null, references: [] }
  }
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
  if (input.exclude && input.exclude.length > 0) {
    conditions.push(`NOT EXISTS (
      SELECT 1
      FROM json_each(@excludedSessions) AS excluded
      WHERE json_extract(excluded.value, '$.agent') = sessions.agent
        AND json_extract(excluded.value, '$.id') = sessions.id
    )`)
    params.excludedSessions = JSON.stringify(input.exclude)
  }
  const scopeConditions = [...conditions]
  const scopeParams = { ...params }
  if (cursor) {
    conditions.push('(updated_at < @cursorUpdatedAt OR (updated_at = @cursorUpdatedAt AND id < @cursorId))')
    params.cursorUpdatedAt = cursor.updatedAt
    params.cursorId = cursor.id
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const scopeWhere = scopeConditions.length > 0 ? `WHERE ${scopeConditions.join(' AND ')}` : ''
  const db = new Database(getDbPath(input.homeDir), { readonly: true })
  try {
    const references = db.prepare(`
      SELECT id, agent
      FROM sessions
      ${scopeWhere}
      ORDER BY updated_at DESC, id DESC
    `).all(scopeParams) as SessionContextReference[]
    const rows = db.prepare(`
      SELECT id, agent, source_path, slug, updated_at, status
      FROM sessions
      ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT @fetchLimit
    `).all(params) as SessionContextRow[]
    const hasMore = rows.length > limit
    const visible = rows.slice(0, limit)
    const last = visible.at(-1)
    return {
      items: mapRows(visible),
      nextCursor: hasMore && last
        ? encodeCursor({ updatedAt: last.updated_at, id: last.id })
        : null,
      references,
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
  if (!isDatabaseReady(homeDir)) return references.map(missingReference)
  const db = new Database(getDbPath(homeDir), { readonly: true })
  try {
    const rows = db.prepare(`
      SELECT id, agent, source_path, slug, updated_at, status
      FROM sessions
      WHERE id IN (
        SELECT json_extract(requested.value, '$.id')
        FROM json_each(@references) AS requested
      )
    `).all({ references: JSON.stringify(references) }) as SessionContextRow[]
    const byKey = new Map(mapRows(rows).map((item) => [`${item.agent}\0${item.id}`, item]))
    return references.map((reference) => {
      return byKey.get(`${reference.agent}\0${reference.id}`) ?? missingReference(reference)
    })
  } finally {
    db.close()
  }
}

function mapRows(rows: SessionContextRow[]): SessionContextItem[] {
  const displayNames = resolveSessionDisplayNames(rows.map((row) => ({
    id: row.id,
    agent: row.agent,
    sourcePath: row.source_path,
    slug: row.slug,
  })))
  return rows.map((row) => ({
    id: row.id,
    agent: row.agent,
    displayName: displayNames.get(sessionKey(row.agent, row.id))
      ?? `${row.slug} · ${row.agent}`,
    slug: row.slug,
    updatedAt: row.updated_at,
    status: row.status,
    sourceAvailable: row.status !== 'missing' && row.status !== 'error',
  }))
}

function missingReference(reference: SessionContextReference): SessionContextItem {
  return {
    id: reference.id,
    agent: reference.agent as AgentName,
    displayName: `${reference.agent} session`,
    slug: 'unknown',
    updatedAt: '',
    status: 'missing',
    sourceAvailable: false,
  }
}

export function resolveSessionDisplayNames(
  sessions: SessionDisplayNameSource[],
): Map<string, string> {
  const names = new Map<string, string>()
  readOpenCodeTitles(sessions, names)
  readCodexTitles(sessions, names)
  for (const session of sessions) {
    const key = sessionKey(session.agent, session.id)
    if (names.has(key)) continue
    if (session.agent === 't3' || session.agent === 'antigravity') {
      if (fs.existsSync(session.sourcePath)) {
        const title = session.agent === 't3'
          ? t3Title(session.sourcePath, decodeURIComponent(session.id.slice(3)))
          : antigravityTitle(session.sourcePath, session.id)
        if (title) names.set(key, title)
      }
      continue
    }
    const title = session.agent === 'copilot'
      ? readCopilotTitle(session.sourcePath)
      : session.agent === 'grok'
        ? grokSessionTitle(session.sourcePath)
        : readJsonlTitle(session.sourcePath, session.agent)
    if (title) names.set(key, title)
  }
  return names
}

function readOpenCodeTitles(
  rows: SessionDisplayNameSource[],
  titles: Map<string, string>,
): void {
  const bySource = new Map<string, string[]>()
  for (const row of rows) {
    if (row.agent !== 'opencode') continue
    const ids = bySource.get(row.sourcePath) ?? []
    ids.push(row.id)
    bySource.set(row.sourcePath, ids)
  }
  for (const [sourcePath, ids] of bySource) {
    try {
      const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
      try {
        const placeholders = ids.map(() => '?').join(', ')
        const records = source.prepare(`SELECT id, title FROM session WHERE id IN (${placeholders})`)
          .all(...ids) as Array<{ id: string; title?: unknown }>
        for (const record of records) {
          if (typeof record.title === 'string' && record.title.trim()) {
            titles.set(sessionKey('opencode', record.id), normalizeTitle(record.title))
          }
        }
      } finally {
        source.close()
      }
    } catch {
      // A missing or incompatible source falls back to the project and agent label.
    }
  }
}

function readCodexTitles(
  sessions: SessionDisplayNameSource[],
  titles: Map<string, string>,
): void {
  const byRoot = new Map<string, string[]>()
  for (const session of sessions) {
    if (session.agent !== 'codex') continue
    const root = codexRoot(session.sourcePath)
    if (!root) continue
    const ids = byRoot.get(root) ?? []
    ids.push(session.id)
    byRoot.set(root, ids)
  }
  for (const [root, ids] of byRoot) {
    const statePath = path.join(root, 'state_5.sqlite')
    try {
      const db = new Database(statePath, { readonly: true, fileMustExist: true })
      try {
        const columns = new Set(
          (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>)
            .map(({ name }) => name),
        )
        const titleColumns = ['name', 'title', 'first_user_message']
          .filter((column) => columns.has(column))
        if (titleColumns.length === 0) continue
        for (let offset = 0; offset < ids.length; offset += 200) {
          const batch = ids.slice(offset, offset + 200)
          const placeholders = batch.map(() => '?').join(', ')
          const records = db.prepare(
            `SELECT id, ${titleColumns.join(', ')} FROM threads WHERE id IN (${placeholders})`,
          ).all(...batch) as Array<Record<string, unknown> & { id: string }>
          for (const record of records) {
            const title = titleColumns
              .map((column) => record[column])
              .find((value) => typeof value === 'string' && value.trim())
            if (typeof title === 'string') {
              titles.set(sessionKey('codex', record.id), normalizeTitle(title))
            }
          }
        }
      } finally {
        db.close()
      }
    } catch {
      // Missing or incompatible Codex state falls back to its rollout JSONL.
    }
  }
}

function codexRoot(sourcePath: string): string | null {
  for (const marker of [`${path.sep}sessions${path.sep}`, `${path.sep}archived_sessions${path.sep}`]) {
    const index = sourcePath.indexOf(marker)
    if (index >= 0) return sourcePath.slice(0, index)
  }
  return null
}

function readCopilotTitle(sourcePath: string): string | null {
  try {
    const document = parseYaml(fs.readFileSync(sourcePath, 'utf8')) as Record<string, unknown>
    for (const key of ['name', 'summary']) {
      if (typeof document[key] === 'string' && document[key].trim()) {
        return normalizeTitle(document[key])
      }
    }
  } catch {
    // Missing or malformed workspaces use the stable project/agent fallback.
  }
  return null
}

function readJsonlTitle(sourcePath: string, agent: AgentName): string | null {
  if (!sourcePath.endsWith('.jsonl')) return null
  try {
    const descriptor = fs.openSync(sourcePath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(512 * 1024)
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0)
      const lines = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/)
      let firstUserMessage: string | null = null
      for (const line of lines) {
        if (!line.trim()) continue
        let record: Record<string, unknown>
        try {
          record = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (agent === 'claude' && record.type === 'ai-title') {
          const aiTitle = record.aiTitle
          if (typeof aiTitle === 'string' && aiTitle.trim()) return normalizeTitle(aiTitle)
        }
        firstUserMessage ??= userMessageText(record)
      }
      return firstUserMessage
    } finally {
      fs.closeSync(descriptor)
    }
  } catch {
    return null
  }
}

function userMessageText(record: Record<string, unknown>): string | null {
  const message = asRecord(record.message)
  const payload = asRecord(record.payload)
  const role = record.role ?? message.role ?? payload.role
  const isCodexUserEvent = record.type === 'event_msg' && payload.type === 'user_message'
  if (role !== 'user' && record.type !== 'user' && !isCodexUserEvent) return null
  return firstText(
    isCodexUserEvent ? payload.message : record.content ?? message.content ?? payload.content,
  )
}

function firstText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? normalizeTitle(value) : null
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstText(item)
      if (text) return text
    }
    return null
  }
  const record = asRecord(value)
  for (const key of ['text', 'input_text', 'content']) {
    const text = firstText(record[key])
    if (text) return text
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function normalizeTitle(value: string): string {
  const normalized = redactSecrets(value).replace(/\s+/g, ' ').trim()
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}…`
}

function sessionKey(agent: string, id: string): string {
  return `${agent}\0${id}`
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
