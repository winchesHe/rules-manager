import Database from 'better-sqlite3'
import type { RuleCandidateRow } from '@memory-manager/core/rule-candidates'
import type { GenerationRequest } from './generation-controller.js'

type GenerationMode = GenerationRequest['mode']

export type GenerationHistoryStatus =
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'

interface GenerationHistoryEvidenceProject {
  slug: string
  sessionIds: string[]
  roundCount: number
  excerptCount: number
}

export interface GenerationHistoryEntry {
  id: string
  startedAt: string
  endedAt?: string
  status: GenerationHistoryStatus
  request: {
    mode: GenerationMode
    projects: string[]
  }
  evidence?: {
    projectCount: number
    totalSessions: number
    projects?: GenerationHistoryEvidenceProject[]
    createdAt?: string
  }
  candidateCount: number
  candidates: RuleCandidateRow[]
  failure?: string
}

interface GenerationRunRow {
  id: string
  started_at: string
  ended_at: string | null
  status: GenerationHistoryStatus
  details: string | null
}

export function listGenerationHistory(
  dbPath: string,
  limit = 10,
): GenerationHistoryEntry[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('generation history limit must be positive')
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare(`
      SELECT id, started_at, ended_at, status, details
      FROM run_metadata
      WHERE run_type = 'generate-rules'
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit) as GenerationRunRow[]
    const canLoadCandidates = hasCandidateRunId(db)
    const candidateQuery = canLoadCandidates
      ? db.prepare(`
          SELECT * FROM rule_candidates
          WHERE run_id = ?
          ORDER BY created_at, id
        `)
      : undefined
    return rows.map((row) => ({
      ...parseGenerationRun(row),
      candidates: candidateQuery
        ? candidateQuery.all(row.id) as RuleCandidateRow[]
        : [],
    }))
  } finally {
    db.close()
  }
}

function parseGenerationRun(row: GenerationRunRow): GenerationHistoryEntry {
  let details: unknown = {}
  if (row.details) {
    try {
      details = JSON.parse(row.details)
    } catch {
      throw new Error(`generation ${row.id} metadata contains invalid JSON`)
    }
  }
  if (!isRecord(details)) {
    throw new Error(`generation ${row.id} metadata is not an object`)
  }
  const request = parseRequest(details.request)
  const evidence = parseEvidence(details.evidence)
  const candidateCount =
    typeof details.candidateCount === 'number'
    && Number.isInteger(details.candidateCount)
    && details.candidateCount >= 0
      ? details.candidateCount
      : 0
  return {
    id: row.id,
    startedAt: row.started_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    status: row.status,
    request,
    ...(evidence ? { evidence } : {}),
    candidateCount,
    candidates: [],
    ...(typeof details.failure === 'string' ? { failure: details.failure } : {}),
  }
}

function parseRequest(value: unknown): GenerationHistoryEntry['request'] {
  if (!isRecord(value)) return { mode: 'recent', projects: [] }
  const mode = value.mode
  const projects = Array.isArray(value.projects)
    ? value.projects.filter((item): item is string => typeof item === 'string')
    : []
  if (mode === 'projects') return { mode, projects }
  if (mode === 'changed7d' || mode === 'full' || mode === 'recent') {
    return { mode, projects: [] }
  }
  return { mode: 'recent', projects: [] }
}

function parseEvidence(
  value: unknown,
): GenerationHistoryEntry['evidence'] | undefined {
  if (
    !isRecord(value)
    || typeof value.projectCount !== 'number'
    || typeof value.totalSessions !== 'number'
  ) {
    return undefined
  }
  return {
    projectCount: value.projectCount,
    totalSessions: value.totalSessions,
    ...(Array.isArray(value.projects)
      ? { projects: value.projects.flatMap(parseEvidenceProject) }
      : {}),
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
  }
}

function parseEvidenceProject(value: unknown): GenerationHistoryEvidenceProject[] {
  if (
    !isRecord(value)
    || typeof value.slug !== 'string'
    || !Array.isArray(value.sessionIds)
    || typeof value.roundCount !== 'number'
    || typeof value.excerptCount !== 'number'
  ) {
    return []
  }
  return [{
    slug: value.slug,
    sessionIds: value.sessionIds.filter(
      (sessionId): sessionId is string => typeof sessionId === 'string',
    ),
    roundCount: value.roundCount,
    excerptCount: value.excerptCount,
  }]
}

function hasCandidateRunId(db: Database.Database): boolean {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rule_candidates'",
  ).get()
  if (!table) return false
  return (db.pragma('table_info(rule_candidates)') as Array<{ name: string }>)
    .some((column) => column.name === 'run_id')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
