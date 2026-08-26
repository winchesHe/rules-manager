import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readSessionEventSources,
  type SessionEvent,
  type SessionEventReadResult,
} from './session-events.js'
import {
  evaluateSessionQueryContent,
  type MatchProof,
  type PredicateResult,
  type SelectionCoverage,
  type SessionQuery,
  type SessionQueryExecution,
  type SessionSelectionOutcome,
} from './session-query.js'
import type { AgentName } from './types.js'

export const SESSION_CONTEXT_RUN_SCHEMA_VERSION = 4 as const
export const DEFAULT_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000
export const DEFAULT_CONTEXT_PART_BYTES = 16 * 1024
export const DEFAULT_CONTEXT_PAGE_SIZE = 50
export const MAX_CONTEXT_PAGE_SIZE = 200

const RUN_PREFIX = 'memory-manager-context-'
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface SessionContextManifestSession {
  id: string
  agent: AgentName
  projectSlug?: string
  eventCountAtPrepare: number
  sourceRevisionAtPrepare?: SessionEventReadResult['sourceRevision']
  proofs: MatchProof[]
}

export interface SessionContextSessionSummary {
  id: string
  agent: AgentName
  projectSlug?: string
  eventCountAtPrepare: number
  sourceRevisionAtPrepare?: SessionEventReadResult['sourceRevision']
  proofCount: number
  proofKinds: Partial<Record<MatchProof['kind'], number>>
  toolFamilies: string[]
  contentMode: 'live-source'
}

export interface SessionContextManifest {
  schemaVersion: typeof SESSION_CONTEXT_RUN_SCHEMA_VERSION
  runId: string
  contentMode: 'live-source'
  contentStored: false
  query: SessionQuery
  queryHash: string
  evaluatedAt: string
  createdAt: string
  expiresAt: string
  coverage: SelectionCoverage
  outcomes: SessionSelectionOutcome[]
  sessions: SessionContextManifestSession[]
}

export interface SessionContextEventSegment {
  kind: 'event_segment'
  eventIndex: number
  segmentIndex: number
  segmentCount: number
  eventHash: string
  encoding: 'json'
  data: string
  sourceLocator: string
}

export type SessionContextItem = SessionEvent | SessionContextEventSegment

export interface SessionContextPart {
  runId: string
  sessionId: string
  agent: AgentName
  contentMode: 'live-source'
  readAt: string
  selectionStatus: PredicateResult['status']
  selectionChanged: boolean
  sourceChangedSincePrepare: boolean
  sourceRevision?: SessionEventReadResult['sourceRevision']
  currentProofCount: number
  part: number
  partCount: number
  eventCount: number
  itemCount: number
  payloadBytes: number
  payloadHash: string
  events: SessionContextItem[]
}

export interface CreateSessionContextRunOptions {
  parentDir?: string
  now?: Date
  ttlMs?: number
}

export interface LiveSessionContextOptions {
  parentDir?: string
  homeDir?: string
  now?: Date
  maxPartBytes?: number
  readSources?: typeof readSessionEventSources
}

export interface SessionContextRunSummary {
  runId: string
  contentMode: 'live-source'
  contentStored: false
  createdAt: string
  expiresAt: string
  queryHash: string
  coverage: SelectionCoverage
  sessionCount: number
  limitations: string[]
}

export interface SessionContextPage<T> {
  runId: string
  total: number
  returned: number
  cursor: string
  nextCursor?: string
  items: T[]
}

export interface ListSessionContextPageOptions {
  cursor?: string
  limit?: number
}

export interface ListSessionContextOutcomeOptions extends ListSessionContextPageOptions {
  status?: SessionSelectionOutcome['selectionStatus']
}

export interface SessionContextEventLocation {
  runId: string
  sessionId: string
  requestedEventIndex: number
  eventIndex: number
  sourceLocator: string
  contentMode: 'live-source'
  locatedAt: string
  selectionStatus: PredicateResult['status']
  selectionChanged: boolean
  sourceChangedSincePrepare: boolean
  proofAnchorChanged: boolean
  sourceRevision?: SessionEventReadResult['sourceRevision']
  firstPart: number
  lastPart: number
  suggestedFromPart: number
  suggestedToPart: number
  partCount: number
}

interface LiveSessionState {
  session: SessionContextManifestSession
  source: SessionEventReadResult
  evaluation: PredicateResult
  readAt: string
  sourceChangedSincePrepare: boolean
}

function contextParentDir(parentDir?: string): string {
  return parentDir ?? path.join(os.tmpdir(), 'memory-manager-context-runs')
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`无效 context run id：${runId}`)
}

function runDirectory(runId: string, parentDir?: string): string {
  assertRunId(runId)
  return path.join(contextParentDir(parentDir), `${RUN_PREFIX}${runId}`)
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  fs.chmodSync(filePath, 0o600)
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
  } catch {
    throw new Error(`context 文件损坏：${filePath}`)
  }
}

function isManifest(value: unknown): value is SessionContextManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === SESSION_CONTEXT_RUN_SCHEMA_VERSION
    && typeof record.runId === 'string'
    && record.contentMode === 'live-source'
    && record.contentStored === false
    && typeof record.createdAt === 'string'
    && typeof record.expiresAt === 'string'
    && Array.isArray(record.sessions)
    && Array.isArray(record.outcomes)
}

function loadManifest(runId: string, parentDir?: string): SessionContextManifest {
  const rootDir = runDirectory(runId, parentDir)
  if (!fs.existsSync(rootDir)) throw new Error(`context run 不存在：${runId}`)
  const value = readJson(path.join(rootDir, 'manifest.json'))
  if (!isManifest(value) || value.runId !== runId) {
    throw new Error(`context run manifest 校验失败：${runId}`)
  }
  return value
}

function readOwnedExpiry(rootDir: string, runId: string): string | undefined {
  for (const name of ['owner.json', 'manifest.json']) {
    try {
      const value = readJson(path.join(rootDir, name))
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      if (record.runId === runId && typeof record.expiresAt === 'string') {
        return record.expiresAt
      }
    } catch {
      // 继续尝试另一个所有权文件。
    }
  }
  return undefined
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function serializedItemBytes(item: SessionContextItem): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8') + 1
}

function safeStringEnd(value: string, start: number, end: number): number {
  if (end <= start || end >= value.length) return end
  const previous = value.charCodeAt(end - 1)
  const next = value.charCodeAt(end)
  return previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF
    ? end - 1
    : end
}

function segmentSessionEvent(
  event: SessionEvent,
  maxPartBytes: number,
): SessionContextEventSegment[] {
  const serialized = JSON.stringify(event)
  const eventHash = sha256(serialized)
  const chunks: string[] = []
  let start = 0
  while (start < serialized.length) {
    let low = start + 1
    let high = serialized.length
    let best = start
    while (low <= high) {
      const middle = safeStringEnd(serialized, start, Math.floor((low + high) / 2))
      if (middle <= start) {
        low += 1
        continue
      }
      const candidate: SessionContextEventSegment = {
        kind: 'event_segment',
        eventIndex: event.index,
        segmentIndex: Number.MAX_SAFE_INTEGER,
        segmentCount: Number.MAX_SAFE_INTEGER,
        eventHash,
        encoding: 'json',
        data: serialized.slice(start, middle),
        sourceLocator: event.sourceLocator,
      }
      if (serializedItemBytes(candidate) <= maxPartBytes) {
        best = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (best <= start) {
      throw new Error('maxPartBytes 太小，无法容纳 context event segment 元数据')
    }
    chunks.push(serialized.slice(start, best))
    start = best
  }
  return chunks.map((data, index) => ({
    kind: 'event_segment',
    eventIndex: event.index,
    segmentIndex: index + 1,
    segmentCount: chunks.length,
    eventHash,
    encoding: 'json',
    data,
    sourceLocator: event.sourceLocator,
  }))
}

function contextItemsForEvent(event: SessionEvent, maxPartBytes: number): SessionContextItem[] {
  return serializedItemBytes(event) <= maxPartBytes
    ? [event]
    : segmentSessionEvent(event, maxPartBytes)
}

export function partitionSessionEvents(
  events: SessionEvent[],
  maxPartBytes = DEFAULT_CONTEXT_PART_BYTES,
): SessionContextItem[][] {
  if (!Number.isInteger(maxPartBytes) || maxPartBytes <= 0) {
    throw new Error('maxPartBytes 必须是正整数')
  }
  const parts: SessionContextItem[][] = []
  let current: SessionContextItem[] = []
  let currentBytes = 0
  for (const event of events) {
    for (const item of contextItemsForEvent(event, maxPartBytes)) {
      const bytes = serializedItemBytes(item)
      if (current.length > 0 && currentBytes + bytes > maxPartBytes) {
        parts.push(current)
        current = []
        currentBytes = 0
      }
      current.push(item)
      currentBytes += bytes
    }
  }
  if (current.length > 0) parts.push(current)
  return parts
}

function isEventSegment(item: SessionContextItem): item is SessionContextEventSegment {
  return item.kind === 'event_segment'
}

export function reassembleSessionContextItems(items: SessionContextItem[]): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let index = 0; index < items.length;) {
    const item = items[index]
    if (!isEventSegment(item)) {
      events.push(item)
      index += 1
      continue
    }
    const segments = items.slice(index, index + item.segmentCount)
    if (
      segments.length !== item.segmentCount
      || !segments.every((segment, segmentIndex) => (
        isEventSegment(segment)
        && segment.eventIndex === item.eventIndex
        && segment.eventHash === item.eventHash
        && segment.segmentCount === item.segmentCount
        && segment.segmentIndex === segmentIndex + 1
      ))
    ) {
      throw new Error(`context event segment 不完整：event ${item.eventIndex}`)
    }
    const serialized = segments.map((segment) => (
      isEventSegment(segment) ? segment.data : ''
    )).join('')
    if (sha256(serialized) !== item.eventHash) {
      throw new Error(`context event segment 哈希不一致：event ${item.eventIndex}`)
    }
    const event = JSON.parse(serialized) as SessionEvent
    if (event.index !== item.eventIndex || event.sourceLocator !== item.sourceLocator) {
      throw new Error(`context event segment 身份不一致：event ${item.eventIndex}`)
    }
    events.push(event)
    index += item.segmentCount
  }
  return events
}

function limitationsFor(coverage: SelectionCoverage): string[] {
  return coverage.unknown > 0
    ? [`${coverage.unknown} 个候选 Session 无法检查，不能声明已找到全部相关 Session`]
    : []
}

function matchedManifestSessions(
  execution: SessionQueryExecution,
): SessionContextManifestSession[] {
  return execution.outcomes
    .filter((outcome) => outcome.selectionStatus === 'matched')
    .map((outcome) => ({
      id: outcome.sessionId,
      agent: outcome.agent,
      projectSlug: outcome.projectSlug,
      eventCountAtPrepare: outcome.eventCount,
      sourceRevisionAtPrepare: outcome.sourceRevision,
      proofs: outcome.proofs,
    }))
}

export function createSessionContextRun(
  execution: SessionQueryExecution,
  options: CreateSessionContextRunOptions = {},
): SessionContextRunSummary {
  const now = options.now ?? new Date()
  const ttlMs = options.ttlMs ?? DEFAULT_CONTEXT_TTL_MS
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs 必须大于 0')
  const runId = crypto.randomUUID()
  const parentDir = contextParentDir(options.parentDir)
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(parentDir, 0o700)
  const rootDir = runDirectory(runId, parentDir)
  fs.mkdirSync(rootDir, { mode: 0o700 })
  fs.chmodSync(rootDir, 0o700)
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
  try {
    writePrivateJson(path.join(rootDir, 'owner.json'), {
      runId,
      state: 'preparing',
      createdAt,
      expiresAt,
    })
    const sessions = matchedManifestSessions(execution)
    if (sessions.length !== execution.coverage.matched) {
      throw new Error(
        `context run Session 数 ${sessions.length} 与 matched ${execution.coverage.matched} 不一致`,
      )
    }
    const manifest: SessionContextManifest = {
      schemaVersion: SESSION_CONTEXT_RUN_SCHEMA_VERSION,
      runId,
      contentMode: 'live-source',
      contentStored: false,
      query: execution.query,
      queryHash: execution.queryHash,
      evaluatedAt: execution.evaluatedAt,
      createdAt,
      expiresAt,
      coverage: execution.coverage,
      outcomes: execution.outcomes,
      sessions,
    }
    writePrivateJson(path.join(rootDir, 'manifest.json'), manifest)
    writePrivateJson(path.join(rootDir, 'owner.json'), {
      runId,
      state: 'ready',
      createdAt,
      expiresAt,
    })
    return {
      runId,
      contentMode: 'live-source',
      contentStored: false,
      createdAt,
      expiresAt,
      queryHash: execution.queryHash,
      coverage: execution.coverage,
      sessionCount: sessions.length,
      limitations: limitationsFor(execution.coverage),
    }
  } catch (error) {
    fs.rmSync(rootDir, { recursive: true, force: true })
    throw error
  }
}

function revisionChanged(
  before: SessionEventReadResult['sourceRevision'] | undefined,
  current: SessionEventReadResult['sourceRevision'] | undefined,
): boolean {
  if (!before && !current) return false
  return before?.kind !== current?.kind || before?.fingerprint !== current?.fingerprint
}

async function loadLiveSession(
  runId: string,
  sessionId: string,
  options: LiveSessionContextOptions,
): Promise<LiveSessionState> {
  const manifest = loadManifest(runId, options.parentDir)
  const session = manifest.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error(`context run 中没有 Session：${sessionId}`)
  const readSources = options.readSources ?? readSessionEventSources
  const [source] = await readSources(
    [{ id: session.id, agent: session.agent }],
    { homeDir: options.homeDir },
  )
  if (!source || source.status === 'unavailable' || source.status === 'failed') {
    const code = source?.errorCode ?? 'SOURCE_READ_FAILED'
    const message = source?.errorMessage ?? `无法读取 Session：${sessionId}`
    throw new Error(`Session 实时回源失败（${code}）：${message}`)
  }
  const evaluation = evaluateSessionQueryContent(manifest.query, source.events)
  return {
    session,
    source,
    evaluation,
    readAt: (options.now ?? new Date()).toISOString(),
    sourceChangedSincePrepare: revisionChanged(
      session.sourceRevisionAtPrepare,
      source.sourceRevision,
    ),
  }
}

export async function readSessionContextPart(
  runId: string,
  sessionId: string,
  part: number,
  options: LiveSessionContextOptions = {},
): Promise<SessionContextPart> {
  if (!Number.isInteger(part) || part < 1) throw new Error('part 必须是从 1 开始的整数')
  const state = await loadLiveSession(runId, sessionId, options)
  const partitioned = partitionSessionEvents(
    state.source.events,
    options.maxPartBytes ?? DEFAULT_CONTEXT_PART_BYTES,
  )
  const parts = partitioned.length > 0 ? partitioned : [[]]
  if (part > parts.length) {
    throw new Error(`Session ${sessionId} 当前只有 ${parts.length} 个分片`)
  }
  const events = parts[part - 1]
  const payload = JSON.stringify(events)
  return {
    runId,
    sessionId,
    agent: state.session.agent,
    contentMode: 'live-source',
    readAt: state.readAt,
    selectionStatus: state.evaluation.status,
    selectionChanged: state.evaluation.status !== 'matched',
    sourceChangedSincePrepare: state.sourceChangedSincePrepare,
    sourceRevision: state.source.sourceRevision,
    currentProofCount: state.evaluation.proofs.length,
    part,
    partCount: parts.length,
    eventCount: state.source.eventCount,
    itemCount: events.length,
    payloadBytes: Buffer.byteLength(payload, 'utf8'),
    payloadHash: sha256(payload),
    events,
  }
}

function pageBounds(options: ListSessionContextPageOptions): {
  offset: number
  limit: number
} {
  const cursor = options.cursor ?? '0'
  if (!/^\d+$/.test(cursor)) throw new Error('cursor 必须是非负整数')
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset)) throw new Error('cursor 超出安全整数范围')
  const limit = options.limit ?? DEFAULT_CONTEXT_PAGE_SIZE
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTEXT_PAGE_SIZE) {
    throw new Error(`limit 必须是 1-${MAX_CONTEXT_PAGE_SIZE} 的整数`)
  }
  return { offset, limit }
}

function pageItems<T>(
  runId: string,
  items: T[],
  options: ListSessionContextPageOptions,
): SessionContextPage<T> {
  const { offset, limit } = pageBounds(options)
  const page = items.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  return {
    runId,
    total: items.length,
    returned: page.length,
    cursor: String(offset),
    ...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {}),
    items: page,
  }
}

export function listSessionContextSessions(
  runId: string,
  options: ListSessionContextPageOptions = {},
  parentDir?: string,
): SessionContextPage<SessionContextSessionSummary> {
  const manifest = loadManifest(runId, parentDir)
  return pageItems(runId, manifest.sessions.map((session) => {
    const proofKinds: SessionContextSessionSummary['proofKinds'] = {}
    const toolFamilies = new Set<string>()
    for (const proof of session.proofs) {
      proofKinds[proof.kind] = (proofKinds[proof.kind] ?? 0) + 1
      if (proof.family) toolFamilies.add(proof.family)
    }
    return {
      id: session.id,
      agent: session.agent,
      projectSlug: session.projectSlug,
      eventCountAtPrepare: session.eventCountAtPrepare,
      sourceRevisionAtPrepare: session.sourceRevisionAtPrepare,
      proofCount: session.proofs.length,
      proofKinds,
      toolFamilies: [...toolFamilies].sort(),
      contentMode: 'live-source' as const,
    }
  }), options)
}

export function listSessionContextProofs(
  runId: string,
  sessionId: string,
  options: ListSessionContextPageOptions = {},
  parentDir?: string,
): SessionContextPage<MatchProof> {
  const manifest = loadManifest(runId, parentDir)
  const session = manifest.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error(`context run 中没有 Session：${sessionId}`)
  return pageItems(runId, session.proofs, options)
}

function proofMeaningMatches(left: MatchProof, right: MatchProof): boolean {
  return left.kind === right.kind
    && left.contentHash === right.contentHash
    && left.term === right.term
    && left.field === right.field
    && left.origin === right.origin
    && left.family === right.family
    && left.toolName === right.toolName
    && left.operation === right.operation
    && left.provenance === right.provenance
}

function eventPartRange(
  parts: SessionContextItem[][],
  eventIndex: number,
): { firstPart: number; lastPart: number } | undefined {
  let firstPart: number | undefined
  let lastPart: number | undefined
  parts.forEach((items, partIndex) => {
    if (items.some((item) => (
      item.kind === 'event_segment' ? item.eventIndex === eventIndex : item.index === eventIndex
    ))) {
      firstPart ??= partIndex + 1
      lastPart = partIndex + 1
    }
  })
  return firstPart && lastPart ? { firstPart, lastPart } : undefined
}

export async function locateSessionContextEvent(
  runId: string,
  sessionId: string,
  eventIndex: number,
  options: LiveSessionContextOptions = {},
): Promise<SessionContextEventLocation> {
  if (!Number.isInteger(eventIndex) || eventIndex < 0) {
    throw new Error('event 必须是非负整数')
  }
  const state = await loadLiveSession(runId, sessionId, options)
  const preparedProof = state.session.proofs.find((proof) => proof.eventIndex === eventIndex)
  if (!preparedProof?.sourceLocator) {
    throw new Error(`Session ${sessionId} 的 event ${eventIndex} 不是可定位的 proof`)
  }
  const refreshedProof = state.evaluation.proofs.find((proof) => (
    proof.sourceLocator === preparedProof.sourceLocator
  )) ?? state.evaluation.proofs.find((proof) => proofMeaningMatches(preparedProof, proof))
  const sourceLocator = refreshedProof?.sourceLocator ?? preparedProof.sourceLocator
  const event = state.source.events.find((candidate) => candidate.sourceLocator === sourceLocator)
  if (!event) {
    throw new Error(
      `Session ${sessionId} 的 proof 锚点已不在最新源中：${preparedProof.sourceLocator}`,
    )
  }
  const parts = partitionSessionEvents(
    state.source.events,
    options.maxPartBytes ?? DEFAULT_CONTEXT_PART_BYTES,
  )
  const range = eventPartRange(parts, event.index)
  if (!range) throw new Error(`Session ${sessionId} 无法定位最新 event ${event.index}`)
  return {
    runId,
    sessionId,
    requestedEventIndex: eventIndex,
    eventIndex: event.index,
    sourceLocator,
    contentMode: 'live-source',
    locatedAt: state.readAt,
    selectionStatus: state.evaluation.status,
    selectionChanged: state.evaluation.status !== 'matched',
    sourceChangedSincePrepare: state.sourceChangedSincePrepare,
    proofAnchorChanged: sourceLocator !== preparedProof.sourceLocator,
    sourceRevision: state.source.sourceRevision,
    firstPart: range.firstPart,
    lastPart: range.lastPart,
    suggestedFromPart: Math.max(1, range.firstPart - 1),
    suggestedToPart: Math.min(parts.length, range.lastPart + 1),
    partCount: parts.length,
  }
}

export function listSessionContextOutcomes(
  runId: string,
  options: ListSessionContextOutcomeOptions = {},
  parentDir?: string,
): SessionContextPage<SessionSelectionOutcome> {
  const manifest = loadManifest(runId, parentDir)
  const outcomes = options.status
    ? manifest.outcomes.filter((outcome) => outcome.selectionStatus === options.status)
    : manifest.outcomes
  return pageItems(runId, outcomes, options)
}

export function getSessionContextStatus(
  runId: string,
  parentDir?: string,
): SessionContextRunSummary {
  const manifest = loadManifest(runId, parentDir)
  return {
    runId: manifest.runId,
    contentMode: manifest.contentMode,
    contentStored: manifest.contentStored,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    queryHash: manifest.queryHash,
    coverage: manifest.coverage,
    sessionCount: manifest.sessions.length,
    limitations: limitationsFor(manifest.coverage),
  }
}

export function closeSessionContextRun(
  runId: string,
  parentDir?: string,
): { runId: string; status: 'closed' | 'not_found' } {
  const rootDir = runDirectory(runId, parentDir)
  if (!fs.existsSync(rootDir)) return { runId, status: 'not_found' }
  if (!readOwnedExpiry(rootDir, runId)) {
    throw new Error(`context run 所有权校验失败：${runId}`)
  }
  fs.rmSync(rootDir, { recursive: true, force: true })
  return { runId, status: 'closed' }
}

export function cleanupStaleSessionContextRuns(options: {
  parentDir?: string
  now?: Date
} = {}): string[] {
  const parentDir = contextParentDir(options.parentDir)
  if (!fs.existsSync(parentDir)) return []
  const now = (options.now ?? new Date()).getTime()
  const removed: string[] = []
  for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUN_PREFIX)) continue
    const runId = entry.name.slice(RUN_PREFIX.length)
    if (!RUN_ID_PATTERN.test(runId)) continue
    try {
      const rootDir = runDirectory(runId, parentDir)
      const expiresAt = readOwnedExpiry(rootDir, runId)
      if (!expiresAt || Date.parse(expiresAt) > now) continue
      fs.rmSync(rootDir, { recursive: true, force: true })
      removed.push(runId)
    } catch {
      // 只清理 owner/manifest 可验证且确已过期的本工具目录。
    }
  }
  return removed
}
