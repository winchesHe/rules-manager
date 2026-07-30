import Database from 'better-sqlite3'
import type { AgentName, ScanChange, ScanSummary } from '../../core/src/types.js'

export interface StoredScanStatus {
  summary: ScanSummary
  completedAt: string
  restored: true
  sinceDays?: number
}

export type ScanScope =
  | { mode: 'full' }
  | { mode: 'recent'; days: number }

export interface ScanHistoryEntry {
  id: string
  startedAt: string
  completedAt: string
  status: 'success' | 'partial' | 'cancelled'
  summary: ScanSummary
  scope: ScanScope
}

export interface ScanHistoryOptions {
  days?: number
  now?: Date
  limit?: number
}

interface ScanRunRow {
  id: string
  started_at: string
  ended_at: string
  status: 'success' | 'partial' | 'cancelled'
  details: string
}

const supportedAgents: AgentName[] = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'opencode',
  'pi',
]

export function loadLatestCompletedScan(dbPath: string): StoredScanStatus | undefined {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(`
      SELECT id, started_at, ended_at, status, details
      FROM run_metadata
      WHERE run_type = 'scan'
        AND status IN ('success', 'partial')
        AND ended_at IS NOT NULL
        AND details IS NOT NULL
      ORDER BY ended_at DESC
      LIMIT 1
    `).get() as ScanRunRow | undefined
    if (!row) return undefined

    const scan = parseScanRun(row)
    return {
      summary: scan.summary,
      completedAt: scan.completedAt,
      restored: true,
      ...(scan.scope.mode === 'recent' ? { sinceDays: scan.scope.days } : {}),
    }
  } finally {
    db.close()
  }
}

export function listCompletedScans(
  dbPath: string,
  options: ScanHistoryOptions = {},
): ScanHistoryEntry[] {
  const days = options.days
  const limit = options.limit
  if (days !== undefined && (!Number.isInteger(days) || days <= 0)) {
    throw new Error('scan history days must be positive')
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('scan history limit must be positive')
  }
  const now = options.now ?? new Date()
  if (Number.isNaN(now.getTime())) throw new Error('scan history now must be valid')
  const cutoff =
    days === undefined
      ? undefined
      : new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()

  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = cutoff === undefined
      ? db.prepare(`
          SELECT id, started_at, ended_at, status, details
          FROM run_metadata
          WHERE run_type = 'scan'
            AND status IN ('success', 'partial', 'cancelled')
            AND ended_at IS NOT NULL
            AND details IS NOT NULL
          ORDER BY ended_at DESC
          LIMIT ?
        `).all(limit ?? -1) as ScanRunRow[]
      : db.prepare(`
          SELECT id, started_at, ended_at, status, details
          FROM run_metadata
          WHERE run_type = 'scan'
            AND status IN ('success', 'partial', 'cancelled')
            AND ended_at IS NOT NULL
            AND ended_at >= ?
            AND details IS NOT NULL
          ORDER BY ended_at DESC
          LIMIT ?
        `).all(cutoff, limit ?? -1) as ScanRunRow[]
    return rows.map(parseScanRun)
  } finally {
    db.close()
  }
}

export function listChangedSessionIds(
  dbPath: string,
  options: ScanHistoryOptions = {},
): string[] {
  const ids = new Set<string>()
  for (const run of listCompletedScans(dbPath, {
    ...options,
    days: options.days ?? 7,
  })) {
    if (run.status === 'cancelled') continue
    for (const change of [...run.summary.changes.new, ...run.summary.changes.updated]) {
      ids.add(change.id)
    }
  }
  return [...ids]
}

function parseScanRun(row: ScanRunRow): ScanHistoryEntry {
  let details: unknown
  try {
    details = JSON.parse(row.details)
  } catch {
    throw new Error(`scan ${row.id} metadata contains invalid JSON`)
  }
  if (!isRecord(details) || !isRecord(details.summary)) {
    throw new Error(`scan ${row.id} metadata does not contain a summary`)
  }
  return {
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.ended_at,
    status: row.status,
    summary: parseScanSummary(details.summary),
    scope: parseScanScope(details.scope),
  }
}

function parseScanScope(value: unknown): ScanScope {
  if (
    isRecord(value) &&
    value.mode === 'recent' &&
    typeof value.days === 'number' &&
    Number.isInteger(value.days) &&
    value.days > 0
  ) {
    return { mode: 'recent', days: value.days }
  }
  return { mode: 'full' }
}

function parseScanSummary(value: Record<string, unknown>): ScanSummary {
  const numericFields = [
    'total',
    'new',
    'updated',
    'unchanged',
    'missing',
    'errors',
  ] as const
  for (const field of numericFields) {
    if (typeof value[field] !== 'number') {
      throw new Error(`scan summary has an invalid ${field}`)
    }
  }

  const changes = isRecord(value.changes) ? value.changes : {}
  return {
    total: value.total as number,
    new: value.new as number,
    updated: value.updated as number,
    unchanged: value.unchanged as number,
    missing: value.missing as number,
    errors: value.errors as number,
    changes: {
      new: parseChanges(changes.new, 'new'),
      updated: parseChanges(changes.updated, 'updated'),
      missing: parseChanges(changes.missing, 'missing'),
    },
  }
}

function parseChanges(value: unknown, field: string): ScanChange[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`scan summary has invalid ${field} changes`)
  }
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.agent !== 'string' ||
      !supportedAgents.includes(item.agent as AgentName) ||
      typeof item.id !== 'string' ||
      typeof item.slug !== 'string'
    ) {
      throw new Error(`scan summary has an invalid ${field} change`)
    }
    return {
      agent: item.agent as AgentName,
      id: item.id,
      slug: item.slug,
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
