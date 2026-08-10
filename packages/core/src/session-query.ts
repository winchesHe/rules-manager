import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { z } from 'zod'
import {
  readSessionEventSources,
  type SessionEvent,
  type SessionEventReadResult,
} from './session-events.js'
import type { AgentName, SessionStatus } from './types.js'
import { resolveWorkspace } from './workspace.js'

export const SESSION_QUERY_VERSION = 1 as const
export const TOOL_REGISTRY_VERSION = 1 as const

const agentSchema = z.enum(['claude', 'codex', 'copilot', 'cursor', 'opencode', 'pi'])
const statusSchema = z.enum(['new', 'updated', 'unchanged', 'missing', 'error'])
const keywordFieldSchema = z.enum([
  'user',
  'assistant',
  'tool_call_input',
  'tool_result_output',
  'title',
])
const provenanceSchema = z.enum(['direct', 'nested', 'capability-derived'])

const timeSchema = z.object({
  lastDays: z.number().int().positive().max(3650).optional(),
  since: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'since 必须是 ISO 8601 时间').optional(),
  until: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'until 必须是 ISO 8601 时间').optional(),
}).strict().superRefine((value, context) => {
  if (value.lastDays !== undefined && (value.since !== undefined || value.until !== undefined)) {
    context.addIssue({ code: 'custom', message: 'lastDays 不能和 since/until 混用' })
  }
  if (
    value.since !== undefined
    && value.until !== undefined
    && Date.parse(value.since) > Date.parse(value.until)
  ) {
    context.addIssue({ code: 'custom', message: 'since 不能晚于 until' })
  }
})

const scopeSchema = z.object({
  agents: z.array(agentSchema).min(1).optional(),
  projects: z.array(z.string().trim().min(1).max(200)).min(1).optional(),
  statuses: z.array(statusSchema).min(1).optional(),
}).strict()

const toolPredicateSchema = z.object({
  families: z.array(z.string().trim().min(1).max(100)).min(1).optional(),
  names: z.array(z.string().trim().min(1).max(200)).min(1).optional(),
  operations: z.array(z.string().trim().min(1).max(100)).min(1).optional(),
  provenance: z.array(provenanceSchema).min(1).optional(),
}).strict().refine(
  (value) => value.families || value.names || value.operations,
  'tool 至少需要 families、names 或 operations 之一',
)

const keywordPredicateSchema = z.object({
  terms: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
  mode: z.enum(['any', 'all']).default('any'),
  fields: z.array(keywordFieldSchema).min(1).optional(),
  caseSensitive: z.boolean().default(false),
}).strict()

export type ToolProvenance = z.infer<typeof provenanceSchema>
export type KeywordField = z.infer<typeof keywordFieldSchema>
export type ToolPredicate = z.infer<typeof toolPredicateSchema>
export type KeywordPredicate = z.infer<typeof keywordPredicateSchema>

export type SessionPredicate =
  | { all: SessionPredicate[] }
  | { any: SessionPredicate[] }
  | { not: SessionPredicate }
  | { tool: ToolPredicate }
  | { keyword: KeywordPredicate }

const predicateSchema: z.ZodType<SessionPredicate> = z.lazy(() => z.union([
  z.object({ all: z.array(predicateSchema).min(1) }).strict(),
  z.object({ any: z.array(predicateSchema).min(1) }).strict(),
  z.object({ not: predicateSchema }).strict(),
  z.object({ tool: toolPredicateSchema }).strict(),
  z.object({ keyword: keywordPredicateSchema }).strict(),
]))

const querySchema = z.object({
  version: z.literal(SESSION_QUERY_VERSION),
  time: timeSchema.optional(),
  scope: scopeSchema.optional(),
  where: predicateSchema.optional(),
}).strict()

export type SessionQuery = z.infer<typeof querySchema>

export interface ToolSignal {
  family?: string
  toolName: string
  operation?: string
  provenance: ToolProvenance
  eventIndex: number
  sourceLocator: string
}

export interface MatchProof {
  kind: 'all' | 'tool' | 'keyword' | 'not'
  eventIndex?: number
  sourceLocator?: string
  contentHash?: string
  term?: string
  field?: KeywordField
  family?: string
  toolName?: string
  operation?: string
  provenance?: ToolProvenance
  predicateHash?: string
}

export interface SessionSelectionOutcome {
  sessionId: string
  agent: AgentName
  projectSlug: string
  updatedAt: string
  status: SessionStatus
  selectionStatus: 'matched' | 'not_matched' | 'unknown'
  eventCount: number
  proofs: MatchProof[]
  sourceRevision?: SessionEventReadResult['sourceRevision']
  errorCode?: SessionEventReadResult['errorCode']
  errorMessage?: string
}

export interface SelectionCoverage {
  candidates: number
  inspected: number
  matched: number
  notMatched: number
  unknown: number
  changedDuringRun: number
}

export interface SessionQueryExecution {
  query: SessionQuery
  queryHash: string
  evaluatedAt: string
  coverage: SelectionCoverage
  outcomes: SessionSelectionOutcome[]
  matchedSources: SessionEventReadResult[]
}

export interface RunSessionQueryOptions {
  homeDir?: string
  now?: Date
  signal?: AbortSignal
  retainMatchedSources?: boolean
  onMatchedSource?: (
    source: SessionEventReadResult,
    outcome: SessionSelectionOutcome,
  ) => void | Promise<void>
}

interface CandidateRow {
  id: string
  agent: AgentName
  slug: string
  updated_at: string
  status: SessionStatus
}

interface PredicateResult {
  matched: boolean
  proofs: MatchProof[]
}

const DEFAULT_KEYWORD_FIELDS: KeywordField[] = [
  'user',
  'assistant',
  'tool_call_input',
  'tool_result_output',
  'title',
]
const MAX_PREDICATE_DEPTH = 8
const NESTED_TOOL_CALL_PATTERN = /tools\.((?:mcp__)?(?:computer[_-]use|chrome)(?:__[A-Za-z0-9_$-]+)*)\s*\(/gi

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function assertPredicateDepth(predicate: SessionPredicate, depth = 1): void {
  if (depth > MAX_PREDICATE_DEPTH) {
    throw new Error(`where 递归深度不能超过 ${MAX_PREDICATE_DEPTH}`)
  }
  if ('all' in predicate) {
    predicate.all.forEach((child) => assertPredicateDepth(child, depth + 1))
  } else if ('any' in predicate) {
    predicate.any.forEach((child) => assertPredicateDepth(child, depth + 1))
  } else if ('not' in predicate) {
    assertPredicateDepth(predicate.not, depth + 1)
  }
}

export function parseSessionQuery(value: unknown): SessionQuery {
  const parsed = querySchema.parse(value)
  if (parsed.where) assertPredicateDepth(parsed.where)
  return parsed
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_')
}

function directToolFamily(name: string): string | undefined {
  const normalized = normalizeToolName(name)
  if (
    normalized === 'computer_use'
    || normalized === 'computer_use_legacy'
    || normalized.startsWith('mcp__computer_use__')
  ) return 'computer-use'
  if (
    normalized === 'chrome_use'
    || normalized === 'control_chrome'
    || normalized.startsWith('mcp__chrome__')
  ) return 'chrome-use'
  return undefined
}

function capabilityToolFamily(name: string): string | undefined {
  const normalized = normalizeToolName(name)
  if (normalized === 'computer') return 'computer-use'
  if (normalized === 'chrome') return 'chrome-use'
  return undefined
}

function contentOperation(content: unknown): string | undefined {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return undefined
  const record = content as Record<string, unknown>
  for (const key of ['action', 'operation', 'command']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function nameOperation(name: string): string | undefined {
  const parts = name.split('__')
  return parts.length > 1 ? parts.at(-1) : undefined
}

function signalFor(
  event: SessionEvent,
  toolName: string,
  provenance: ToolProvenance,
): ToolSignal {
  return {
    ...(directToolFamily(toolName) ?? capabilityToolFamily(toolName)
      ? { family: directToolFamily(toolName) ?? capabilityToolFamily(toolName) }
      : {}),
    toolName,
    ...(contentOperation(event.content) ?? nameOperation(toolName)
      ? { operation: contentOperation(event.content) ?? nameOperation(toolName) }
      : {}),
    provenance,
    eventIndex: event.index,
    sourceLocator: event.sourceLocator,
  }
}

export function extractToolSignals(events: SessionEvent[]): ToolSignal[] {
  return events.flatMap((event): ToolSignal[] => {
    if (event.kind !== 'tool_call' || !event.toolName) return []
    const signals: ToolSignal[] = []
    const directFamily = directToolFamily(event.toolName)
    const capabilityFamily = capabilityToolFamily(event.toolName)
    if (directFamily) signals.push(signalFor(event, event.toolName, 'direct'))
    else if (capabilityFamily) signals.push(signalFor(event, event.toolName, 'capability-derived'))
    else signals.push(signalFor(event, event.toolName, 'direct'))

    const outerName = normalizeToolName(event.toolName)
    if (outerName.includes('exec') || outerName.includes('node_repl') || outerName.endsWith('__js')) {
      const input = typeof event.content === 'string'
        ? event.content
        : JSON.stringify(event.content)
      for (const match of input.matchAll(NESTED_TOOL_CALL_PATTERN)) {
        const nestedName = match[1]
        signals.push(signalFor(event, nestedName, 'nested'))
      }
    }
    return signals
  })
}

function searchableContent(event: SessionEvent, field: KeywordField): unknown | undefined {
  if (field === 'user' && event.kind === 'message' && event.role === 'user') return event.content
  if (field === 'assistant' && event.kind === 'message' && event.role === 'assistant') {
    return event.content
  }
  if (field === 'tool_call_input' && event.kind === 'tool_call') return event.content
  if (field === 'tool_result_output' && event.kind === 'tool_result') return event.content
  if (field === 'title' && event.kind === 'metadata') {
    const record = event.content && typeof event.content === 'object' && !Array.isArray(event.content)
      ? event.content as Record<string, unknown>
      : undefined
    return typeof record?.title === 'string' ? record.title : undefined
  }
  return undefined
}

function asSearchText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function evaluateKeyword(
  predicate: KeywordPredicate,
  events: SessionEvent[],
): PredicateResult {
  const fields = predicate.fields ?? DEFAULT_KEYWORD_FIELDS
  const terms = predicate.caseSensitive
    ? predicate.terms
    : predicate.terms.map((term) => term.toLocaleLowerCase())
  const proofsByTerm = new Map<string, MatchProof[]>()
  for (const originalTerm of predicate.terms) proofsByTerm.set(originalTerm, [])

  for (const event of events) {
    for (const field of fields) {
      const content = searchableContent(event, field)
      if (content === undefined) continue
      const rawText = asSearchText(content)
      const text = predicate.caseSensitive ? rawText : rawText.toLocaleLowerCase()
      for (const [index, term] of terms.entries()) {
        if (!text.includes(term)) continue
        const originalTerm = predicate.terms[index]
        proofsByTerm.get(originalTerm)!.push({
          kind: 'keyword',
          eventIndex: event.index,
          sourceLocator: event.sourceLocator,
          contentHash: stableHash(content),
          term: originalTerm,
          field,
        })
      }
    }
  }

  const matchedTerms = predicate.terms.filter((term) => proofsByTerm.get(term)!.length > 0)
  const matched = predicate.mode === 'all'
    ? matchedTerms.length === predicate.terms.length
    : matchedTerms.length > 0
  return {
    matched,
    proofs: matched
      ? matchedTerms.map((term) => proofsByTerm.get(term)![0])
      : [],
  }
}

function includesNormalized(values: string[] | undefined, target: string | undefined): boolean {
  if (!values) return true
  if (!target) return false
  const normalizedTarget = normalizeToolName(target)
  return values.some((value) => normalizeToolName(value) === normalizedTarget)
}

function evaluateTool(predicate: ToolPredicate, events: SessionEvent[]): PredicateResult {
  const signals = extractToolSignals(events).filter((signal) => (
    includesNormalized(predicate.families, signal.family)
    && includesNormalized(predicate.names, signal.toolName)
    && includesNormalized(predicate.operations, signal.operation)
    && (!predicate.provenance || predicate.provenance.includes(signal.provenance))
  ))
  const seen = new Set<string>()
  const uniqueSignals = signals.filter((signal) => {
    const key = [
      signal.family,
      signal.toolName,
      signal.operation,
      signal.provenance,
    ].join('\0')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    matched: uniqueSignals.length > 0,
    proofs: uniqueSignals.map((signal) => ({
      kind: 'tool',
      eventIndex: signal.eventIndex,
      sourceLocator: signal.sourceLocator,
      family: signal.family,
      toolName: signal.toolName,
      operation: signal.operation,
      provenance: signal.provenance,
    })),
  }
}

function uniqueProofs(proofs: MatchProof[]): MatchProof[] {
  const seen = new Set<string>()
  return proofs.filter((proof) => {
    const key = JSON.stringify(proof)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function evaluateSessionPredicate(
  predicate: SessionPredicate,
  events: SessionEvent[],
): PredicateResult {
  if ('tool' in predicate) return evaluateTool(predicate.tool, events)
  if ('keyword' in predicate) return evaluateKeyword(predicate.keyword, events)
  if ('not' in predicate) {
    const child = evaluateSessionPredicate(predicate.not, events)
    return {
      matched: !child.matched,
      proofs: child.matched ? [] : [{ kind: 'not', predicateHash: stableHash(predicate.not) }],
    }
  }
  const children = ('all' in predicate ? predicate.all : predicate.any)
    .map((child) => evaluateSessionPredicate(child, events))
  const matched = 'all' in predicate
    ? children.every((child) => child.matched)
    : children.some((child) => child.matched)
  return {
    matched,
    proofs: matched
      ? uniqueProofs(children.filter((child) => child.matched).flatMap((child) => child.proofs))
      : [],
  }
}

function queryWindow(query: SessionQuery, now: Date): { since?: string; until?: string } {
  if (query.time?.lastDays !== undefined) {
    return {
      since: new Date(now.getTime() - query.time.lastDays * 24 * 60 * 60 * 1000).toISOString(),
      until: now.toISOString(),
    }
  }
  return {
    ...(query.time?.since ? { since: new Date(query.time.since).toISOString() } : {}),
    ...(query.time?.until ? { until: new Date(query.time.until).toISOString() } : {}),
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function loadCandidates(
  query: SessionQuery,
  now: Date,
  homeDir?: string,
): CandidateRow[] {
  const db = new Database(resolveWorkspace(homeDir).dbPath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const clauses: string[] = []
    const parameters: unknown[] = []
    const window = queryWindow(query, now)
    if (window.since) {
      clauses.push('updated_at >= ?')
      parameters.push(window.since)
    }
    if (window.until) {
      clauses.push('updated_at <= ?')
      parameters.push(window.until)
    }
    if (query.scope?.agents) {
      clauses.push(`agent IN (${placeholders(query.scope.agents.length)})`)
      parameters.push(...query.scope.agents)
    }
    if (query.scope?.projects) {
      clauses.push(`slug IN (${placeholders(query.scope.projects.length)})`)
      parameters.push(...query.scope.projects)
    }
    if (query.scope?.statuses) {
      clauses.push(`status IN (${placeholders(query.scope.statuses.length)})`)
      parameters.push(...query.scope.statuses)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    return db.prepare(`
      SELECT id, agent, slug, updated_at, status
      FROM sessions
      ${where}
      ORDER BY updated_at DESC, id ASC
    `).all(...parameters) as CandidateRow[]
  } finally {
    db.close()
  }
}

export async function runSessionQuery(
  value: unknown,
  options: RunSessionQueryOptions = {},
): Promise<SessionQueryExecution> {
  const query = parseSessionQuery(value)
  const now = options.now ?? new Date()
  const candidates = loadCandidates(query, now, options.homeDir)
  const outcomes: SessionSelectionOutcome[] = []
  const matchedSources: SessionEventReadResult[] = []

  for (const candidate of candidates) {
    const [source] = await readSessionEventSources(
      [{ id: candidate.id, agent: candidate.agent }],
      { homeDir: options.homeDir, signal: options.signal },
    )
    if (source.status === 'unavailable' || source.status === 'failed') {
      outcomes.push({
        sessionId: candidate.id,
        agent: candidate.agent,
        projectSlug: candidate.slug,
        updatedAt: candidate.updated_at,
        status: candidate.status,
        selectionStatus: 'unknown',
        eventCount: 0,
        proofs: [],
        sourceRevision: source.sourceRevision,
        errorCode: source.errorCode,
        errorMessage: source.errorMessage,
      })
      continue
    }

    const evaluation = query.where
      ? evaluateSessionPredicate(query.where, source.events)
      : { matched: true, proofs: [{ kind: 'all' as const }] }
    const selectionStatus = evaluation.matched ? 'matched' : 'not_matched'
    const outcome: SessionSelectionOutcome = {
      sessionId: candidate.id,
      agent: candidate.agent,
      projectSlug: candidate.slug,
      updatedAt: candidate.updated_at,
      status: candidate.status,
      selectionStatus,
      eventCount: source.eventCount,
      proofs: evaluation.proofs,
      sourceRevision: source.sourceRevision,
      ...(source.errorCode ? { errorCode: source.errorCode } : {}),
      ...(source.errorMessage ? { errorMessage: source.errorMessage } : {}),
    }
    outcomes.push(outcome)
    if (evaluation.matched) {
      await options.onMatchedSource?.(source, outcome)
      if (options.retainMatchedSources !== false) matchedSources.push(source)
    }
  }

  const matched = outcomes.filter((outcome) => outcome.selectionStatus === 'matched').length
  const notMatched = outcomes.filter((outcome) => outcome.selectionStatus === 'not_matched').length
  const unknown = outcomes.filter((outcome) => outcome.selectionStatus === 'unknown').length
  const coverage: SelectionCoverage = {
    candidates: outcomes.length,
    inspected: matched + notMatched,
    matched,
    notMatched,
    unknown,
    changedDuringRun: outcomes.filter((outcome) => (
      outcome.sourceRevision?.changedDuringRun
    )).length,
  }
  return {
    query,
    queryHash: stableHash(query),
    evaluatedAt: now.toISOString(),
    coverage,
    outcomes,
    matchedSources,
  }
}
