import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import type { SessionEvent, SessionEventReadResult } from './session-events.js'
import type {
  MatchProof,
  SelectionCoverage,
  SessionQuery,
  SessionQueryExecution,
  SessionSelectionOutcome,
} from './session-query.js'
import type { AgentName } from './types.js'

export const SESSION_CONTEXT_RUN_SCHEMA_VERSION = 3 as const
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
  eventCount: number
  partCount: number
  storageFile?: string
  sourceRevision?: SessionEventReadResult['sourceRevision']
  proofs: MatchProof[]
  eventParts: SessionContextEventPartLocation[]
  partStorage: SessionContextPartStorage[]
}

export interface SessionContextPartStorage {
  part: number
  offset: number
  length: number
}

export interface SessionContextEventPartLocation {
  eventIndex: number
  firstPart: number
  lastPart: number
}

export interface SessionContextSessionSummary {
  id: string
  agent: AgentName
  projectSlug?: string
  eventCount: number
  partCount: number
  sourceRevision?: SessionEventReadResult['sourceRevision']
  proofCount: number
  proofKinds: Partial<Record<MatchProof['kind'], number>>
  toolFamilies: string[]
}

export interface SessionContextManifest {
  schemaVersion: typeof SESSION_CONTEXT_RUN_SCHEMA_VERSION
  runId: string
  query: SessionQuery
  queryHash: string
  evaluatedAt: string
  createdAt: string
  expiresAt: string
  coverage: SelectionCoverage
  outcomes: SessionSelectionOutcome[]
  sessions: SessionContextManifestSession[]
}

export interface SessionContextPart {
  runId: string
  sessionId: string
  agent: AgentName
  part: number
  partCount: number
  eventCount: number
  itemCount: number
  payloadBytes: number
  payloadHash: string
  events: SessionContextItem[]
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

export interface CreateSessionContextRunOptions {
  parentDir?: string
  now?: Date
  ttlMs?: number
  maxPartBytes?: number
}

export interface SessionContextRunSummary {
  runId: string
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
  eventIndex: number
  firstPart: number
  lastPart: number
  suggestedFromPart: number
  suggestedToPart: number
}

export interface SessionContextRunWriter {
  runId: string
  writeMatchedSession: (
    source: SessionEventReadResult,
    outcome: SessionSelectionOutcome,
  ) => void
  finalize: (execution: SessionQueryExecution) => SessionContextRunSummary
  cleanup: () => void
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

function safeChildPath(rootDir: string, relativePath: string): string {
  const resolvedRoot = path.resolve(rootDir)
  const resolved = path.resolve(rootDir, relativePath)
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`context manifest 包含越界路径：${relativePath}`)
  }
  return resolved
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
    && typeof record.createdAt === 'string'
    && typeof record.expiresAt === 'string'
    && Array.isArray(record.sessions)
    && Array.isArray(record.outcomes)
}

function loadManifest(runId: string, parentDir?: string): {
  rootDir: string
  manifest: SessionContextManifest
} {
  const rootDir = runDirectory(runId, parentDir)
  if (!fs.existsSync(rootDir)) throw new Error(`context run 不存在：${runId}`)
  const value = readJson(path.join(rootDir, 'manifest.json'))
  if (!isManifest(value) || value.runId !== runId) {
    throw new Error(`context run manifest 校验失败：${runId}`)
  }
  return { rootDir, manifest: value }
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
  const limitations: string[] = []
  if (coverage.unknown > 0) {
    limitations.push(`${coverage.unknown} 个候选 Session 无法检查，不能声明已找到全部相关 Session`)
  }
  if (coverage.changedDuringRun > 0) {
    limitations.push(`${coverage.changedDuringRun} 个 Session 在读取期间发生变化，本轮使用已冻结水位`)
  }
  return limitations
}

export function createSessionContextRun(
  execution: SessionQueryExecution,
  options: CreateSessionContextRunOptions = {},
): SessionContextRunSummary {
  const writer = createSessionContextRunWriter(options)
  try {
    const outcomeById = new Map(execution.outcomes.map((outcome) => [outcome.sessionId, outcome]))
    for (const source of execution.matchedSources) {
      const outcome = outcomeById.get(source.sessionId)
      if (!outcome) throw new Error(`缺少 Session selection outcome：${source.sessionId}`)
      writer.writeMatchedSession(source, outcome)
    }
    return writer.finalize(execution)
  } catch (error) {
    writer.cleanup()
    throw error
  }
}

export function createSessionContextRunWriter(
  options: CreateSessionContextRunOptions = {},
): SessionContextRunWriter {
  const now = options.now ?? new Date()
  const ttlMs = options.ttlMs ?? DEFAULT_CONTEXT_TTL_MS
  const maxPartBytes = options.maxPartBytes ?? DEFAULT_CONTEXT_PART_BYTES
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
  writePrivateJson(path.join(rootDir, 'owner.json'), {
    runId,
    state: 'preparing',
    createdAt,
    expiresAt,
  })
  const sessions: SessionContextManifestSession[] = []
  let finalized = false
  let cleaned = false

  function cleanup(): void {
    if (cleaned || finalized) return
    cleaned = true
    fs.rmSync(rootDir, { recursive: true, force: true })
  }

  function writeMatchedSession(
    source: SessionEventReadResult,
    outcome: SessionSelectionOutcome,
  ): void {
    if (finalized || cleaned) throw new Error('context run writer 已结束')
    if (source.sessionId !== outcome.sessionId || outcome.selectionStatus !== 'matched') {
      throw new Error(`Session selection outcome 与 source 不一致：${source.sessionId}`)
    }
    if (sessions.some((session) => session.id === source.sessionId)) {
      throw new Error(`Session 已写入 context run：${source.sessionId}`)
    }
    const index = sessions.length
    const parts = partitionSessionEvents(source.events, maxPartBytes)
    const storageFile = parts.length > 0
      ? path.join('sessions', `session-${String(index + 1).padStart(4, '0')}.parts.gz`)
      : undefined
    const partStorage: SessionContextPartStorage[] = []
    const eventPartRanges = new Map<number, SessionContextEventPartLocation>()
    if (storageFile) {
      const sessionsDir = safeChildPath(rootDir, 'sessions')
      fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 })
      fs.chmodSync(sessionsDir, 0o700)
      const storagePath = safeChildPath(rootDir, storageFile)
      const descriptor = fs.openSync(storagePath, 'wx', 0o600)
      let offset = 0
      try {
        parts.forEach((events, partIndex) => {
          const part = partIndex + 1
          const payload = JSON.stringify(events)
          const partValue = {
            runId,
            sessionId: source.sessionId,
            agent: source.agent,
            part,
            partCount: parts.length,
            eventCount: new Set(events.map((event) => (
              event.kind === 'event_segment' ? event.eventIndex : event.index
            ))).size,
            itemCount: events.length,
            payloadBytes: Buffer.byteLength(payload, 'utf8'),
            payloadHash: sha256(payload),
            events,
          } satisfies SessionContextPart
          const compressed = zlib.gzipSync(`${JSON.stringify(partValue)}\n`)
          const written = fs.writeSync(descriptor, compressed, 0, compressed.length, offset)
          if (written !== compressed.length) {
            throw new Error(`context part 写入不完整：${source.sessionId}/${part}`)
          }
          partStorage.push({ part, offset, length: compressed.length })
          offset += compressed.length
          for (const item of events) {
            const eventIndex = item.kind === 'event_segment' ? item.eventIndex : item.index
            const range = eventPartRanges.get(eventIndex)
            if (range) range.lastPart = part
            else eventPartRanges.set(eventIndex, { eventIndex, firstPart: part, lastPart: part })
          }
        })
      } finally {
        fs.closeSync(descriptor)
        fs.chmodSync(storagePath, 0o600)
      }
    }
    sessions.push({
      id: source.sessionId,
      agent: source.agent,
      projectSlug: source.projectSlug,
      eventCount: source.eventCount,
      partCount: parts.length,
      ...(storageFile ? { storageFile } : {}),
      sourceRevision: source.sourceRevision,
      proofs: outcome.proofs,
      eventParts: [...eventPartRanges.values()],
      partStorage,
    })
  }

  function finalize(execution: SessionQueryExecution): SessionContextRunSummary {
    if (finalized || cleaned) throw new Error('context run writer 已结束')
    if (sessions.length !== execution.coverage.matched) {
      throw new Error(
        `context run 写入 Session 数 ${sessions.length} 与 matched ${execution.coverage.matched} 不一致`,
      )
    }
    const manifest: SessionContextManifest = {
      schemaVersion: SESSION_CONTEXT_RUN_SCHEMA_VERSION,
      runId,
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
    finalized = true
    return {
      runId,
      createdAt,
      expiresAt,
      queryHash: execution.queryHash,
      coverage: execution.coverage,
      sessionCount: sessions.length,
      limitations: limitationsFor(execution.coverage),
    }
  }

  try {
    return {
      runId,
      writeMatchedSession,
      finalize,
      cleanup,
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

export function readSessionContextPart(
  runId: string,
  sessionId: string,
  part: number,
  parentDir?: string,
): SessionContextPart {
  if (!Number.isInteger(part) || part < 1) throw new Error('part 必须是从 1 开始的整数')
  const { rootDir, manifest } = loadManifest(runId, parentDir)
  const session = manifest.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error(`context run 中没有 Session：${sessionId}`)
  if (!session.storageFile || session.partCount === 0) {
    throw new Error(`Session 没有可读取分片：${sessionId}`)
  }
  if (part > session.partCount) {
    throw new Error(`Session ${sessionId} 只有 ${session.partCount} 个分片`)
  }
  const storage = session.partStorage[part - 1]
  if (!storage || storage.part !== part || storage.offset < 0 || storage.length <= 0) {
    throw new Error(`context part 存储索引校验失败：${sessionId}/${part}`)
  }
  const filePath = safeChildPath(rootDir, session.storageFile)
  const descriptor = fs.openSync(filePath, 'r')
  let compressed: Buffer
  try {
    compressed = Buffer.allocUnsafe(storage.length)
    const bytesRead = fs.readSync(descriptor, compressed, 0, storage.length, storage.offset)
    if (bytesRead !== storage.length) throw new Error(`context part 读取不完整：${filePath}`)
  } finally {
    fs.closeSync(descriptor)
  }
  let value: unknown
  try {
    value = JSON.parse(zlib.gunzipSync(compressed).toString('utf8')) as unknown
  } catch {
    throw new Error(`context part 解压或解析失败：${filePath}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`context part 校验失败：${filePath}`)
  }
  const record = value as Record<string, unknown>
  if (
    record.runId !== runId
    || record.sessionId !== sessionId
    || record.part !== part
    || !Array.isArray(record.events)
    || typeof record.payloadBytes !== 'number'
    || typeof record.payloadHash !== 'string'
  ) {
    throw new Error(`context part 校验失败：${filePath}`)
  }
  const payload = JSON.stringify(record.events)
  if (
    Buffer.byteLength(payload, 'utf8') !== record.payloadBytes
    || sha256(payload) !== record.payloadHash
  ) {
    throw new Error(`context part 内容完整性校验失败：${filePath}`)
  }
  return value as SessionContextPart
}

export function getSessionContextStatus(
  runId: string,
  parentDir?: string,
): SessionContextRunSummary {
  const { manifest } = loadManifest(runId, parentDir)
  return {
    runId: manifest.runId,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    queryHash: manifest.queryHash,
    coverage: manifest.coverage,
    sessionCount: manifest.sessions.length,
    limitations: limitationsFor(manifest.coverage),
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
  const { manifest } = loadManifest(runId, parentDir)
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
      eventCount: session.eventCount,
      partCount: session.partCount,
      sourceRevision: session.sourceRevision,
      proofCount: session.proofs.length,
      proofKinds,
      toolFamilies: [...toolFamilies].sort(),
    }
  }), options)
}

export function listSessionContextProofs(
  runId: string,
  sessionId: string,
  options: ListSessionContextPageOptions = {},
  parentDir?: string,
): SessionContextPage<MatchProof> {
  const { manifest } = loadManifest(runId, parentDir)
  const session = manifest.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error(`context run 中没有 Session：${sessionId}`)
  return pageItems(runId, session.proofs, options)
}

export function locateSessionContextEvent(
  runId: string,
  sessionId: string,
  eventIndex: number,
  parentDir?: string,
): SessionContextEventLocation {
  if (!Number.isInteger(eventIndex) || eventIndex < 0) {
    throw new Error('event 必须是非负整数')
  }
  const { manifest } = loadManifest(runId, parentDir)
  const session = manifest.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error(`context run 中没有 Session：${sessionId}`)
  const location = session.eventParts.find((candidate) => candidate.eventIndex === eventIndex)
  if (!location) throw new Error(`Session ${sessionId} 中没有 event ${eventIndex}`)
  return {
    runId,
    sessionId,
    eventIndex,
    firstPart: location.firstPart,
    lastPart: location.lastPart,
    suggestedFromPart: Math.max(1, location.firstPart - 1),
    suggestedToPart: Math.min(session.partCount, location.lastPart + 1),
  }
}

export function listSessionContextOutcomes(
  runId: string,
  options: ListSessionContextOutcomeOptions = {},
  parentDir?: string,
): SessionContextPage<SessionSelectionOutcome> {
  const { manifest } = loadManifest(runId, parentDir)
  const outcomes = options.status
    ? manifest.outcomes.filter((outcome) => outcome.selectionStatus === options.status)
    : manifest.outcomes
  return pageItems(runId, outcomes, options)
}

export function closeSessionContextRun(
  runId: string,
  parentDir?: string,
): { runId: string; status: 'closed' | 'not_found' } {
  const rootDir = runDirectory(runId, parentDir)
  if (!fs.existsSync(rootDir)) return { runId, status: 'not_found' }
  loadManifest(runId, parentDir)
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
      let expiresAt: string
      try {
        expiresAt = loadManifest(runId, parentDir).manifest.expiresAt
      } catch {
        const owner = readJson(path.join(rootDir, 'owner.json'))
        if (!owner || typeof owner !== 'object' || Array.isArray(owner)) continue
        const record = owner as Record<string, unknown>
        if (record.runId !== runId || typeof record.expiresAt !== 'string') continue
        expiresAt = record.expiresAt
      }
      if (Date.parse(expiresAt) > now) continue
      fs.rmSync(runDirectory(runId, parentDir), { recursive: true, force: true })
      removed.push(runId)
    } catch {
      // 只清理 manifest 可验证且确已过期的本工具目录。
    }
  }
  return removed
}
