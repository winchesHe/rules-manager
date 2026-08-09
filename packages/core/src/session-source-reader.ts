import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import Database from 'better-sqlite3'
import { collectFilesRecursive } from './adapters/shared.js'
import { throwIfAborted } from './abort.js'
import type {
  SessionEvidenceReference,
  SourceRevision,
  SessionSourceStatus,
} from './evidence-coverage.js'
import { resolveWorkspace } from './workspace.js'
import type { AgentName, SessionStatus } from './types.js'

export interface SessionSourceMessage {
  role: 'user' | 'assistant'
  content: unknown
  timestamp?: unknown
  [key: string]: unknown
}

export type SessionSourceErrorCode =
  | 'SESSION_NOT_INDEXED'
  | 'SESSION_AGENT_MISMATCH'
  | 'SESSION_INDEX_UNAVAILABLE'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_EMPTY'
  | 'SOURCE_FORMAT_INVALID'
  | 'SOURCE_READ_FAILED'

export interface SessionSourceReadResult {
  sessionId: string
  agent: AgentName
  projectSlug?: string
  status: SessionSourceStatus
  messageCount: number
  messages: SessionSourceMessage[]
  sourceRevision?: SourceRevision
  errorCode?: SessionSourceErrorCode
  errorMessage?: string
}

export interface SessionSourceReaderOptions {
  homeDir?: string
  signal?: AbortSignal
  onVisit?: (reference: SessionEvidenceReference, index: number, total: number) => void
}

export interface SessionSourceReaderDeps {
  afterJsonlSnapshot?: (sourcePath: string) => void
  afterSqliteSnapshot?: (
    dbPath: string,
    references: SessionEvidenceReference[],
  ) => void
}

interface StoredSessionRow {
  id: string
  agent: AgentName
  slug: string
  source_path: string
  status: SessionStatus
}

interface OpenCodeMessageRow {
  msg_data: string
  part_data: string
}

class SourceReaderError extends Error {
  constructor(
    readonly code: SessionSourceErrorCode,
    message: string,
    readonly sourceRevision?: SourceRevision,
  ) {
    super(message)
  }
}

interface SourceReadAttempt {
  messages: SessionSourceMessage[]
  sourceRevision: SourceRevision
}

interface SourceReadFailure {
  error: SourceReaderError
}

type SourceReadOutcome = SourceReadAttempt | SourceReadFailure

interface JsonlFileWatermark {
  filePath: string
  size: number
  mtimeMs: number
}

interface JsonlWatermark {
  sourcePath: string
  directory: boolean
  files: JsonlFileWatermark[]
}

interface SqliteSourceDescriptor {
  kind: 'opencode' | 'copilot'
  dbPath: string
}

const JSONL_AGENTS = new Set<AgentName>(['claude', 'codex', 'cursor', 'pi'])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function normalizeMessage(value: unknown): SessionSourceMessage | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const nested = asRecord(record.message) ?? asRecord(record.payload) ?? asRecord(record.info)
  const eventType = typeof record.type === 'string' ? record.type : ''
  const nestedType = typeof nested?.type === 'string' ? nested.type : ''
  let inferredRole: 'user' | 'assistant' | undefined
  if (eventType.startsWith('user.')) {
    inferredRole = 'user'
  } else if (
    eventType.startsWith('assistant.')
    || ['tool_use', 'tool_result', 'function_call'].includes(nestedType || eventType)
  ) {
    inferredRole = 'assistant'
  }
  const role = nested?.role ?? record.role ?? inferredRole
  if (role !== 'user' && role !== 'assistant') return undefined
  const content = ['tool_use', 'tool_result', 'function_call'].includes(nestedType)
    ? nested
    : nested?.content ?? record.content ?? record.parts ?? record.text
  const timestamp = nested?.timestamp ?? record.timestamp ?? nested?.time ?? record.time
  return { role, content, ...(timestamp === undefined ? {} : { timestamp }) }
}

function sourceMissing(agent: AgentName, sourcePath: string): SourceReaderError {
  return new SourceReaderError('SOURCE_NOT_FOUND', `${agent} session 源不存在：${sourcePath}`)
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function captureJsonlWatermark(sourcePath: string, agent: AgentName): JsonlWatermark {
  if (!fs.existsSync(sourcePath)) throw sourceMissing(agent, sourcePath)
  const directory = fs.statSync(sourcePath).isDirectory()
  const filePaths = directory
    ? collectFilesRecursive(sourcePath, (filePath) => filePath.endsWith('.jsonl'))
    : [sourcePath]
  return {
    sourcePath,
    directory,
    files: filePaths.map((filePath) => {
      const stat = fs.statSync(filePath)
      return { filePath, size: stat.size, mtimeMs: stat.mtimeMs }
    }),
  }
}

function jsonlRevision(watermark: JsonlWatermark): SourceRevision {
  let changedDuringRun = false
  try {
    const current = captureJsonlWatermark(watermark.sourcePath, 'claude')
    changedDuringRun = current.directory !== watermark.directory
      || current.files.length !== watermark.files.length
      || current.files.some((file, index) => {
        const initial = watermark.files[index]
        return !initial
          || file.filePath !== initial.filePath
          || file.size !== initial.size
          || file.mtimeMs !== initial.mtimeMs
      })
  } catch {
    changedDuringRun = true
  }
  return {
    kind: 'jsonl-watermark',
    fingerprint: sha256(watermark.files.map((file) => ({
      path: path.relative(watermark.sourcePath, file.filePath),
      size: file.size,
      mtimeMs: file.mtimeMs,
    }))),
    changedDuringRun,
  }
}

async function readJsonlMessages(
  sourcePath: string,
  agent: AgentName,
  signal?: AbortSignal,
  afterSnapshot?: (sourcePath: string) => void,
): Promise<SourceReadAttempt> {
  const watermark = captureJsonlWatermark(sourcePath, agent)
  afterSnapshot?.(sourcePath)
  const messages: SessionSourceMessage[] = []
  let readError: unknown
  for (const file of watermark.files) {
    if (file.size === 0) continue
    const input = fs.createReadStream(file.filePath, {
      encoding: 'utf8',
      start: 0,
      end: file.size - 1,
    })
    const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
    let lineNumber = 0
    try {
      for await (const rawLine of lines) {
        throwIfAborted(signal)
        lineNumber++
        const line = lineNumber === 1 ? rawLine.replace(/^\uFEFF/, '') : rawLine
        if (!line.trim()) continue
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          throw new SourceReaderError(
            'SOURCE_FORMAT_INVALID',
            `${agent} JSONL 解析失败：${file.filePath}:${lineNumber}`,
          )
        }
        const message = normalizeMessage(record)
        if (message) messages.push(message)
      }
    } catch (error) {
      readError = error
    } finally {
      lines.close()
      input.destroy()
    }
    if (readError) break
  }
  const sourceRevision = jsonlRevision(watermark)
  if (readError) {
    if (readError instanceof SourceReaderError) {
      throw new SourceReaderError(readError.code, readError.message, sourceRevision)
    }
    throw new SourceReaderError('SOURCE_READ_FAILED', String(readError), sourceRevision)
  }
  return { messages, sourceRevision }
}

function findCopilotStore(sourcePath: string): string | undefined {
  let directory = path.dirname(sourcePath)
  while (directory !== path.dirname(directory)) {
    if (path.basename(directory) === 'session-state') {
      const candidate = path.join(path.dirname(directory), 'session-store.db')
      return fs.existsSync(candidate) ? candidate : undefined
    }
    directory = path.dirname(directory)
  }
  return undefined
}

async function readCopilotMessages(
  sourcePath: string,
  signal?: AbortSignal,
  afterSnapshot?: (sourcePath: string) => void,
): Promise<SourceReadAttempt> {
  const eventsPath = path.basename(sourcePath) === 'events.jsonl'
    ? sourcePath
    : path.join(path.dirname(sourcePath), 'events.jsonl')
  if (fs.existsSync(eventsPath)) {
    return readJsonlMessages(eventsPath, 'copilot', signal, afterSnapshot)
  }
  throw sourceMissing('copilot', sourcePath)
}

function readOpenCodeMessagesFromDb(
  db: Database.Database,
  sessionId: string,
  signal?: AbortSignal,
): SessionSourceMessage[] {
  throwIfAborted(signal)
  const rows = db.prepare(`
    SELECT m.data AS msg_data, p.data AS part_data
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ?
    ORDER BY m.time_created, p.id
  `).all(sessionId) as OpenCodeMessageRow[]
  return rows.flatMap((row) => {
    let metadata: Record<string, unknown>
    let part: Record<string, unknown>
    try {
      metadata = JSON.parse(row.msg_data) as Record<string, unknown>
      part = JSON.parse(row.part_data) as Record<string, unknown>
    } catch {
      throw new SourceReaderError(
        'SOURCE_FORMAT_INVALID',
        `OpenCode session 数据解析失败：${sessionId}`,
      )
    }
    const role = metadata.role
    const content = part.text ?? part.content
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) {
      return []
    }
    const time = asRecord(metadata.time)
    return [{
      role,
      content,
      ...(time?.created === undefined ? {} : { timestamp: String(time.created) }),
    }]
  })
}

function readCopilotMessagesFromDb(
  db: Database.Database,
  sessionId: string,
  signal?: AbortSignal,
): SessionSourceMessage[] {
  throwIfAborted(signal)
  const turns = db.prepare(`
    SELECT user_message, assistant_response, timestamp
    FROM turns
    WHERE session_id = ?
    ORDER BY turn_index
  `).all(sessionId) as Array<{
    user_message?: unknown
    assistant_response?: unknown
    timestamp?: unknown
  }>
  return turns.flatMap((turn) => {
    const messages: SessionSourceMessage[] = []
    if (turn.user_message !== null && turn.user_message !== undefined) {
      messages.push({ role: 'user', content: turn.user_message, timestamp: turn.timestamp })
    }
    if (turn.assistant_response !== null && turn.assistant_response !== undefined) {
      messages.push({ role: 'assistant', content: turn.assistant_response, timestamp: turn.timestamp })
    }
    return messages
  })
}

function sqliteDescriptor(session: StoredSessionRow): SqliteSourceDescriptor | undefined {
  if (session.agent === 'opencode') {
    return { kind: 'opencode', dbPath: session.source_path }
  }
  if (session.agent !== 'copilot') return undefined
  const eventsPath = path.basename(session.source_path) === 'events.jsonl'
    ? session.source_path
    : path.join(path.dirname(session.source_path), 'events.jsonl')
  if (fs.existsSync(eventsPath)) return undefined
  const dbPath = findCopilotStore(session.source_path)
  return dbPath ? { kind: 'copilot', dbPath } : undefined
}

function referenceKey(reference: SessionEvidenceReference): string {
  return `${reference.agent}\0${reference.id}`
}

function sqliteGroupKey(descriptor: SqliteSourceDescriptor): string {
  return `${descriptor.kind}\0${descriptor.dbPath}`
}

function readSqliteGroup(
  descriptor: SqliteSourceDescriptor,
  references: SessionEvidenceReference[],
  signal?: AbortSignal,
  afterSnapshot?: SessionSourceReaderDeps['afterSqliteSnapshot'],
): Map<string, SourceReadOutcome> {
  if (!fs.existsSync(descriptor.dbPath)) {
    throw sourceMissing(descriptor.kind, descriptor.dbPath)
  }
  const db = new Database(descriptor.dbPath, { readonly: true, fileMustExist: true })
  const attempts = new Map<string, { messages?: SessionSourceMessage[]; error?: unknown }>()
  try {
    const beforeVersion = db.pragma('data_version', { simple: true }) as number
    const beforeStat = fs.statSync(descriptor.dbPath)
    db.exec('BEGIN')
    db.prepare('SELECT COUNT(*) FROM sqlite_master').get()
    afterSnapshot?.(descriptor.dbPath, references)
    for (const reference of references) {
      try {
        const messages = descriptor.kind === 'opencode'
          ? readOpenCodeMessagesFromDb(db, reference.id, signal)
          : readCopilotMessagesFromDb(db, reference.id, signal)
        attempts.set(referenceKey(reference), { messages })
      } catch (error) {
        if (signal?.aborted) throw error
        attempts.set(referenceKey(reference), { error })
      }
    }
    db.exec('COMMIT')
    const afterVersion = db.pragma('data_version', { simple: true }) as number
    const afterStat = fs.statSync(descriptor.dbPath)
    const sourceRevision: SourceRevision = {
      kind: 'sqlite-transaction',
      fingerprint: sha256({
        dataVersion: beforeVersion,
        size: beforeStat.size,
        mtimeMs: beforeStat.mtimeMs,
      }),
      changedDuringRun: beforeVersion !== afterVersion
        || beforeStat.size !== afterStat.size
        || beforeStat.mtimeMs !== afterStat.mtimeMs,
    }
    return new Map(references.map((reference): [string, SourceReadOutcome] => {
      const attempt = attempts.get(referenceKey(reference))
      if (attempt?.error) {
        const error = attempt.error instanceof SourceReaderError
          ? new SourceReaderError(attempt.error.code, attempt.error.message, sourceRevision)
          : new SourceReaderError('SOURCE_READ_FAILED', String(attempt.error), sourceRevision)
        return [referenceKey(reference), { error }]
      }
      return [referenceKey(reference), {
        messages: attempt?.messages ?? [],
        sourceRevision,
      }]
    }))
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK')
    db.close()
  }
}

async function readNonSqliteMessages(
  session: StoredSessionRow,
  signal?: AbortSignal,
  afterJsonlSnapshot?: SessionSourceReaderDeps['afterJsonlSnapshot'],
): Promise<SourceReadAttempt> {
  if (JSONL_AGENTS.has(session.agent)) {
    return readJsonlMessages(session.source_path, session.agent, signal, afterJsonlSnapshot)
  }
  if (session.agent === 'copilot') {
    return readCopilotMessages(session.source_path, signal, afterJsonlSnapshot)
  }
  throw new SourceReaderError(
    'SOURCE_READ_FAILED',
    `非 SQLite Reader 不支持 Agent：${session.agent}`,
  )
}

function result(
  reference: SessionEvidenceReference,
  status: SessionSourceStatus,
  messages: SessionSourceMessage[] = [],
  details: Pick<
    SessionSourceReadResult,
    'projectSlug' | 'sourceRevision' | 'errorCode' | 'errorMessage'
  > = {},
): SessionSourceReadResult {
  return {
    sessionId: reference.id,
    agent: reference.agent,
    status,
    messageCount: messages.length,
    messages,
    ...details,
  }
}

function loadSessions(
  references: SessionEvidenceReference[],
  homeDir?: string,
): Map<string, StoredSessionRow> {
  const db = new Database(resolveWorkspace(homeDir).dbPath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const query = db.prepare(`
      SELECT id, agent, slug, source_path, status
      FROM sessions
      WHERE id = ?
    `)
    return new Map(references.flatMap((reference) => {
      const row = query.get(reference.id) as StoredSessionRow | undefined
      return row ? [[reference.id, row] as const] : []
    }))
  } finally {
    db.close()
  }
}

export async function readSessionSources(
  references: SessionEvidenceReference[],
  options: SessionSourceReaderOptions = {},
  deps: SessionSourceReaderDeps = {},
): Promise<SessionSourceReadResult[]> {
  const sessions = loadSessions(references, options.homeDir)
  const sqliteGroups = new Map<string, {
    descriptor: SqliteSourceDescriptor
    references: SessionEvidenceReference[]
  }>()
  for (const reference of references) {
    const session = sessions.get(reference.id)
    if (
      !session
      || session.agent !== reference.agent
      || session.status === 'missing'
      || session.status === 'error'
    ) continue
    const descriptor = sqliteDescriptor(session)
    if (!descriptor) continue
    const key = sqliteGroupKey(descriptor)
    const group = sqliteGroups.get(key) ?? { descriptor, references: [] }
    group.references.push(reference)
    sqliteGroups.set(key, group)
  }
  const sqliteOutcomes = new Map<string, SourceReadOutcome>()
  const completedSqliteGroups = new Set<string>()
  const results: SessionSourceReadResult[] = []
  for (const [index, reference] of references.entries()) {
    throwIfAborted(options.signal)
    options.onVisit?.(reference, index, references.length)
    const session = sessions.get(reference.id)
    if (!session) {
      results.push(result(reference, 'unavailable', [], {
        errorCode: 'SESSION_NOT_INDEXED',
        errorMessage: `session 未建立索引：${reference.id}`,
      }))
      continue
    }
    if (session.agent !== reference.agent) {
      results.push(result(reference, 'unavailable', [], {
        projectSlug: session.slug,
        errorCode: 'SESSION_AGENT_MISMATCH',
        errorMessage: `session Agent 不匹配：期望 ${reference.agent}，实际 ${session.agent}`,
      }))
      continue
    }
    if (session.status === 'missing' || session.status === 'error') {
      results.push(result(reference, 'unavailable', [], {
        projectSlug: session.slug,
        errorCode: 'SESSION_INDEX_UNAVAILABLE',
        errorMessage: `session 索引状态不可用：${session.status}`,
      }))
      continue
    }
    try {
      const descriptor = sqliteDescriptor(session)
      let readAttempt: SourceReadAttempt
      if (descriptor) {
        const groupKey = sqliteGroupKey(descriptor)
        if (!completedSqliteGroups.has(groupKey)) {
          const group = sqliteGroups.get(groupKey)!
          try {
            const outcomes = readSqliteGroup(
              group.descriptor,
              group.references,
              options.signal,
              deps.afterSqliteSnapshot,
            )
            for (const [key, outcome] of outcomes) sqliteOutcomes.set(key, outcome)
          } catch (error) {
            const sourceError = error instanceof SourceReaderError
              ? error
              : new SourceReaderError('SOURCE_READ_FAILED', String(error))
            for (const groupedReference of group.references) {
              sqliteOutcomes.set(referenceKey(groupedReference), { error: sourceError })
            }
          }
          completedSqliteGroups.add(groupKey)
        }
        const outcome = sqliteOutcomes.get(referenceKey(reference))!
        if ('error' in outcome) throw outcome.error
        readAttempt = outcome
      } else {
        readAttempt = await readNonSqliteMessages(
          session,
          options.signal,
          deps.afterJsonlSnapshot,
        )
      }
      const { messages, sourceRevision } = readAttempt
      results.push(messages.length > 0
        ? result(reference, 'readable', messages, { projectSlug: session.slug, sourceRevision })
        : result(reference, 'empty', [], {
          projectSlug: session.slug,
          sourceRevision,
          errorCode: 'SOURCE_EMPTY',
          errorMessage: `session 源中没有可用对话：${reference.id}`,
        }))
    } catch (error) {
      if (options.signal?.aborted) throw error
      const knownError = error instanceof SourceReaderError ? error : undefined
      results.push(result(reference, knownError?.code === 'SOURCE_NOT_FOUND' ? 'unavailable' : 'failed', [], {
        projectSlug: session.slug,
        ...(knownError?.sourceRevision ? { sourceRevision: knownError.sourceRevision } : {}),
        errorCode: knownError?.code ?? 'SOURCE_READ_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
      }))
    }
  }
  return results
}
