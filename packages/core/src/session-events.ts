import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import Database from 'better-sqlite3'
import { collectFilesRecursive } from './adapters/shared.js'
import { throwIfAborted } from './abort.js'
import type { SourceRevision, SessionSourceStatus } from './evidence-coverage.js'
import type { SessionSourceErrorCode } from './session-source-reader.js'
import type { AgentName, SessionStatus } from './types.js'
import { resolveWorkspace } from './workspace.js'

export type SessionEventKind =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'media'
  | 'metadata'

export type SessionEventRole = 'user' | 'assistant' | 'system' | 'tool'

export type SessionEventOrigin =
  | 'human_user'
  | 'assistant_output'
  | 'tool_runtime'
  | 'developer_instruction'
  | 'host_context'
  | 'skill_instruction'
  | 'internal_job'
  | 'historical_forward'
  | 'unknown'

export type SessionEventOriginEvidence =
  | 'source-envelope'
  | 'explicit-marker'
  | 'legacy-inferred'

export interface SessionEvent {
  index: number
  kind: SessionEventKind
  role?: SessionEventRole
  timestamp?: string
  content: unknown
  toolCallId?: string
  toolName?: string
  origin: SessionEventOrigin
  originEvidence: SessionEventOriginEvidence
  sourceLocator: string
}

export interface SessionEventReadResult {
  sessionId: string
  agent: AgentName
  projectSlug?: string
  status: SessionSourceStatus
  eventCount: number
  events: SessionEvent[]
  sourceRevision?: SourceRevision
  errorCode?: SessionSourceErrorCode
  errorMessage?: string
}

export interface SessionEventReference {
  id: string
  agent: AgentName
}

export interface SessionEventReaderOptions {
  homeDir?: string
  signal?: AbortSignal
  onVisit?: (reference: SessionEventReference, index: number, total: number) => void
}

export interface SessionEventReaderDeps {
  afterJsonlSnapshot?: (sourcePath: string) => void
  afterSqliteSnapshot?: (sourcePath: string, sessionId: string) => void
}

interface StoredSessionRow {
  id: string
  agent: AgentName
  slug: string
  source_path: string
  status: SessionStatus
}

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

interface EventDraft extends Omit<SessionEvent, 'index' | 'origin' | 'originEvidence'> {}

interface EventReadAttempt {
  events: SessionEvent[]
  sourceRevision: SourceRevision
}

const JSONL_AGENTS = new Set<AgentName>(['claude', 'codex', 'cursor', 'pi'])
const TOOL_CALL_TYPES = new Set([
  'tool_use',
  'toolcall',
  'tool_call',
  'function_call',
  'custom_tool_call',
  'computer_call',
])
const TOOL_RESULT_TYPES = new Set([
  'tool_result',
  'toolresult',
  'function_call_output',
  'custom_tool_call_output',
  'computer_call_output',
])
const TEXT_TYPES = new Set(['text', 'input_text', 'output_text'])
const MEDIA_TYPES = new Set(['image', 'image_url', 'input_image', 'audio', 'video', 'file'])

class SessionEventReaderError extends Error {
  constructor(
    readonly code: SessionSourceErrorCode,
    message: string,
    readonly sourceRevision?: SourceRevision,
  ) {
    super(message)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizedType(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replaceAll('-', '_') : ''
}

function normalizeRole(value: unknown): SessionEventRole | undefined {
  if (value === 'user' || value === 'assistant' || value === 'system' || value === 'tool') {
    return value
  }
  if (value === 'developer') return 'system'
  return undefined
}

function originSearchText(value: unknown): string {
  if (typeof value === 'string') return value.trimStart()
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function classifyOrigin(draft: EventDraft): Pick<SessionEvent, 'origin' | 'originEvidence'> {
  if (draft.kind === 'tool_call' || draft.kind === 'tool_result') {
    return { origin: 'tool_runtime', originEvidence: 'source-envelope' }
  }
  if (draft.role === 'assistant') {
    return { origin: 'assistant_output', originEvidence: 'source-envelope' }
  }
  if (draft.role === 'system') {
    return { origin: 'developer_instruction', originEvidence: 'source-envelope' }
  }
  if (draft.role !== 'user') {
    return { origin: 'unknown', originEvidence: 'legacy-inferred' }
  }

  const text = originSearchText(draft.content)
  if (/^\[memory-manager:[^\]]+\]/i.test(text)) {
    return { origin: 'internal_job', originEvidence: 'explicit-marker' }
  }
  if (/^<(?:skill|skills_instructions)(?:\s|>)/i.test(text)) {
    return { origin: 'skill_instruction', originEvidence: 'explicit-marker' }
  }
  if (
    /^# AGENTS\.md instructions for /i.test(text)
    || /^<(?:app-context|environment_context|permissions instructions|collaboration_mode)(?:\s|>)/i.test(text)
    || /^Side conversation boundary\./i.test(text)
  ) {
    return { origin: 'host_context', originEvidence: 'explicit-marker' }
  }
  if (/^<session_message(?:\s|>)/i.test(text)) {
    return { origin: 'historical_forward', originEvidence: 'explicit-marker' }
  }
  return { origin: 'human_user', originEvidence: 'source-envelope' }
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function timestampOf(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
    if (typeof value === 'number' && Number.isFinite(value)) {
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) return date.toISOString()
    }
  }
  return undefined
}

function toolCallIdOf(value: Record<string, unknown>): string | undefined {
  return asString(value.toolCallId)
    ?? asString(value.tool_call_id)
    ?? asString(value.tool_use_id)
    ?? asString(value.callID)
    ?? asString(value.call_id)
    ?? asString(value.id)
}

function toolNameOf(value: Record<string, unknown>): string | undefined {
  return asString(value.name)
    ?? asString(value.toolName)
    ?? asString(value.tool_name)
    ?? asString(value.tool)
}

function toolCallDraft(
  value: Record<string, unknown>,
  timestamp: string | undefined,
  sourceLocator: string,
): EventDraft {
  const state = asRecord(value.state)
  return {
    kind: 'tool_call',
    role: 'assistant',
    content: value.input
      ?? value.arguments
      ?? value.args
      ?? state?.input
      ?? value.content
      ?? {},
    ...(timestamp ? { timestamp } : {}),
    ...(toolCallIdOf(value) ? { toolCallId: toolCallIdOf(value) } : {}),
    ...(toolNameOf(value) ? { toolName: toolNameOf(value) } : {}),
    sourceLocator,
  }
}

function toolResultDraft(
  value: Record<string, unknown>,
  timestamp: string | undefined,
  sourceLocator: string,
): EventDraft {
  const state = asRecord(value.state)
  return {
    kind: 'tool_result',
    role: 'tool',
    content: value.output
      ?? value.result
      ?? state?.output
      ?? state?.error
      ?? value.content
      ?? value,
    ...(timestamp ? { timestamp } : {}),
    ...(toolCallIdOf(value) ? { toolCallId: toolCallIdOf(value) } : {}),
    ...(toolNameOf(value) ? { toolName: toolNameOf(value) } : {}),
    sourceLocator,
  }
}

function contentDrafts(
  content: unknown,
  role: SessionEventRole | undefined,
  timestamp: string | undefined,
  sourceLocator: string,
): EventDraft[] {
  if (Array.isArray(content)) {
    return content.flatMap((part, index) => (
      contentDrafts(part, role, timestamp, `${sourceLocator}.content[${index}]`)
    ))
  }
  if (typeof content === 'string') {
    return [{
      kind: 'message',
      ...(role ? { role } : {}),
      ...(timestamp ? { timestamp } : {}),
      content,
      sourceLocator,
    }]
  }
  const record = asRecord(content)
  if (!record) {
    return [{
      kind: 'metadata',
      ...(role ? { role } : {}),
      ...(timestamp ? { timestamp } : {}),
      content,
      sourceLocator,
    }]
  }

  const type = normalizedType(record.type)
  if (TOOL_CALL_TYPES.has(type)) return [toolCallDraft(record, timestamp, sourceLocator)]
  if (TOOL_RESULT_TYPES.has(type)) return [toolResultDraft(record, timestamp, sourceLocator)]
  if (type === 'tool') {
    const drafts = [toolCallDraft(record, timestamp, sourceLocator)]
    const state = asRecord(record.state)
    if (state && ('output' in state || 'error' in state)) {
      drafts.push(toolResultDraft(record, timestamp, `${sourceLocator}.state`))
    }
    return drafts
  }
  if (TEXT_TYPES.has(type) && typeof record.text === 'string') {
    return contentDrafts(record.text, role, timestamp, sourceLocator)
  }
  if (MEDIA_TYPES.has(type)) {
    return [{
      kind: 'media',
      ...(role ? { role } : {}),
      ...(timestamp ? { timestamp } : {}),
      content: record,
      sourceLocator,
    }]
  }
  return [{
    kind: 'metadata',
    ...(role ? { role } : {}),
    ...(timestamp ? { timestamp } : {}),
    content: record,
    sourceLocator,
  }]
}

function messageDrafts(
  value: Record<string, unknown>,
  fallbackRole: SessionEventRole | undefined,
  fallbackTimestamp: string | undefined,
  sourceLocator: string,
): EventDraft[] {
  const role = normalizeRole(value.role) ?? fallbackRole
  const timestamp = timestampOf(
    value.timestamp,
    value.time,
    asRecord(value.time)?.created,
    fallbackTimestamp,
  )
  const content = value.content ?? value.parts ?? value.text
  if (content === undefined) {
    return [{
      kind: 'metadata',
      ...(role ? { role } : {}),
      ...(timestamp ? { timestamp } : {}),
      content: value,
      sourceLocator,
    }]
  }
  return contentDrafts(content, role, timestamp, sourceLocator)
}

function compactCodexMetadata(
  type: string,
  value: Record<string, unknown>,
  timestamp: string | undefined,
  sourceLocator: string,
): EventDraft {
  const summary = Array.isArray(value.summary)
    ? value.summary.flatMap((item) => {
      const record = asRecord(item)
      return typeof record?.text === 'string' ? [record.text] : []
    })
    : []
  const git = asRecord(value.git)
  return {
    kind: 'metadata',
    ...(type === 'reasoning' ? { role: 'assistant' as const } : {}),
    ...(timestamp ? { timestamp } : {}),
    content: {
      type,
      ...(asString(value.id) ? { id: asString(value.id) } : {}),
      ...(asString(value.cwd) ? { cwd: asString(value.cwd) } : {}),
      ...(asString(value.call_id) ? { callId: asString(value.call_id) } : {}),
      ...(summary.length > 0 ? { summary } : {}),
      ...(git ? {
        git: {
          ...(asString(git.repository_url) ? { repositoryUrl: asString(git.repository_url) } : {}),
          ...(asString(git.branch) ? { branch: asString(git.branch) } : {}),
          ...(asString(git.commit_hash) ? { commitHash: asString(git.commit_hash) } : {}),
        },
      } : {}),
    },
    sourceLocator,
  }
}

function recordDrafts(
  value: Record<string, unknown>,
  agent: AgentName,
  sourceLocator: string,
): EventDraft[] {
  const type = normalizedType(value.type)
  const timestamp = timestampOf(value.timestamp, value.time)

  if (agent === 'codex' && type === 'response_item') {
    const payload = asRecord(value.payload)
    if (!payload) return contentDrafts(value.payload, undefined, timestamp, `${sourceLocator}.payload`)
    const payloadType = normalizedType(payload.type)
    if (payloadType === 'message' || payloadType === 'user_message' || payloadType === 'agent_message') {
      return messageDrafts(payload, undefined, timestamp, `${sourceLocator}.payload`)
    }
    if (TOOL_CALL_TYPES.has(payloadType)) {
      return [toolCallDraft(payload, timestamp, `${sourceLocator}.payload`)]
    }
    if (TOOL_RESULT_TYPES.has(payloadType)) {
      return [toolResultDraft(payload, timestamp, `${sourceLocator}.payload`)]
    }
    return [compactCodexMetadata(
      payloadType || 'response_item',
      payload,
      timestamp,
      `${sourceLocator}.payload`,
    )]
  }

  if (agent === 'codex' && type === 'session_meta') {
    const payload = asRecord(value.payload) ?? value
    return [compactCodexMetadata('session_meta', payload, timestamp, sourceLocator)]
  }

  if (type === 'user' || type === 'assistant' || type === 'system') {
    const message = asRecord(value.message)
    return message
      ? messageDrafts(message, normalizeRole(type), timestamp, `${sourceLocator}.message`)
      : contentDrafts(value.content ?? value.text, normalizeRole(type), timestamp, sourceLocator)
  }

  if (type === 'message') {
    const message = asRecord(value.message)
    return message
      ? messageDrafts(message, undefined, timestamp, `${sourceLocator}.message`)
      : messageDrafts(value, undefined, timestamp, sourceLocator)
  }

  if (type === 'user.message' || type === 'assistant.message') {
    const role = type.startsWith('user') ? 'user' : 'assistant'
    const nested = asRecord(value.data) ?? asRecord(value.message)
    return nested
      ? messageDrafts(nested, role, timestamp, `${sourceLocator}.${value.data ? 'data' : 'message'}`)
      : contentDrafts(value.content ?? value.text, role, timestamp, sourceLocator)
  }

  if (type === 'tool.execution_start' || type === 'tool_execution_start') {
    const data = asRecord(value.data) ?? value
    return [toolCallDraft(data, timestamp, `${sourceLocator}${value.data ? '.data' : ''}`)]
  }
  if (
    type === 'tool.execution_complete'
    || type === 'tool.execution_end'
    || type === 'tool_execution_complete'
  ) {
    const data = asRecord(value.data) ?? value
    return [toolResultDraft(data, timestamp, `${sourceLocator}${value.data ? '.data' : ''}`)]
  }

  if (value.role !== undefined || value.message !== undefined) {
    const message = asRecord(value.message)
    return message
      ? messageDrafts(message, normalizeRole(value.role), timestamp, `${sourceLocator}.message`)
      : messageDrafts(value, normalizeRole(value.role), timestamp, sourceLocator)
  }

  if (agent === 'codex') {
    // event_msg、turn_context、compacted 与 world_state 都是 response_item 的宿主遥测或重复视图；
    // 其中 mcp_tool_call_end 会再次嵌入完整工具输出，encrypted reasoning 也无法供 AI 解释。
    // 权威消息、调用和结果已经由 response_item 保留，因此不把这些副本放入上下文。
    // 仍保留上方显式的普通消息与 tool.execution_* 兼容格式。
    return []
  }

  return [{
    kind: 'metadata',
    ...(timestamp ? { timestamp } : {}),
    content: value,
    sourceLocator,
  }]
}

function assignIndexes(drafts: EventDraft[]): SessionEvent[] {
  return drafts.map((draft, index) => ({
    ...draft,
    ...classifyOrigin(draft),
    index,
  }))
}

function sourceMissing(agent: AgentName, sourcePath: string): SessionEventReaderError {
  return new SessionEventReaderError(
    'SOURCE_NOT_FOUND',
    `${agent} session 源不存在：${sourcePath}`,
  )
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

function jsonlRevision(watermark: JsonlWatermark, agent: AgentName): SourceRevision {
  let changedDuringRun = false
  try {
    const current = captureJsonlWatermark(watermark.sourcePath, agent)
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
  const baseDir = watermark.directory ? watermark.sourcePath : path.dirname(watermark.sourcePath)
  return {
    kind: 'jsonl-watermark',
    fingerprint: sha256(watermark.files.map((file) => ({
      path: path.relative(baseDir, file.filePath),
      size: file.size,
      mtimeMs: file.mtimeMs,
    }))),
    changedDuringRun,
  }
}

async function readJsonlEvents(
  sourcePath: string,
  agent: AgentName,
  signal?: AbortSignal,
  afterSnapshot?: (sourcePath: string) => void,
): Promise<EventReadAttempt> {
  const watermark = captureJsonlWatermark(sourcePath, agent)
  afterSnapshot?.(sourcePath)
  const drafts: EventDraft[] = []
  const baseDir = watermark.directory ? sourcePath : path.dirname(sourcePath)
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
          throw new SessionEventReaderError(
            'SOURCE_FORMAT_INVALID',
            `${agent} JSONL 解析失败：${file.filePath}:${lineNumber}`,
          )
        }
        const object = asRecord(record)
        if (!object) {
          throw new SessionEventReaderError(
            'SOURCE_FORMAT_INVALID',
            `${agent} JSONL 事件不是对象：${file.filePath}:${lineNumber}`,
          )
        }
        const relativePath = path.relative(baseDir, file.filePath) || path.basename(file.filePath)
        drafts.push(...recordDrafts(object, agent, `${relativePath}:${lineNumber}`))
      }
    } catch (error) {
      readError = error
    } finally {
      lines.close()
      input.destroy()
    }
    if (readError) break
  }

  const sourceRevision = jsonlRevision(watermark, agent)
  if (readError) {
    if (readError instanceof SessionEventReaderError) {
      throw new SessionEventReaderError(readError.code, readError.message, sourceRevision)
    }
    throw new SessionEventReaderError('SOURCE_READ_FAILED', String(readError), sourceRevision)
  }
  return { events: assignIndexes(drafts), sourceRevision }
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

function sqliteAttempt(
  dbPath: string,
  read: (db: Database.Database) => EventDraft[],
  afterSnapshot?: () => void,
): EventReadAttempt {
  if (!fs.existsSync(dbPath)) throw sourceMissing('opencode', dbPath)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const beforeVersion = db.pragma('data_version', { simple: true }) as number
    const beforeStat = fs.statSync(dbPath)
    db.exec('BEGIN')
    afterSnapshot?.()
    const drafts = read(db)
    db.exec('COMMIT')
    const afterVersion = db.pragma('data_version', { simple: true }) as number
    const afterStat = fs.statSync(dbPath)
    return {
      events: assignIndexes(drafts),
      sourceRevision: {
        kind: 'sqlite-transaction',
        fingerprint: sha256({
          dataVersion: beforeVersion,
          size: beforeStat.size,
          mtimeMs: beforeStat.mtimeMs,
        }),
        changedDuringRun: beforeVersion !== afterVersion
          || beforeStat.size !== afterStat.size
          || beforeStat.mtimeMs !== afterStat.mtimeMs,
      },
    }
  } catch (error) {
    if (error instanceof SessionEventReaderError) throw error
    throw new SessionEventReaderError('SOURCE_READ_FAILED', String(error))
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK')
    db.close()
  }
}

function readOpenCodeEvents(
  sourcePath: string,
  sessionId: string,
  signal?: AbortSignal,
  afterSnapshot?: (sourcePath: string, sessionId: string) => void,
): EventReadAttempt {
  return sqliteAttempt(sourcePath, (db) => {
    throwIfAborted(signal)
    const drafts: EventDraft[] = []
    const session = db.prepare('SELECT title FROM session WHERE id = ?').get(sessionId) as {
      title?: unknown
    } | undefined
    if (session?.title !== undefined) {
      drafts.push({
        kind: 'metadata',
        content: { title: session.title },
        sourceLocator: 'session.title',
      })
    }
    const rows = db.prepare(`
      SELECT m.id AS message_id, m.time_created, m.data AS message_data,
             p.id AS part_id, p.data AS part_data
      FROM message m
      LEFT JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY m.time_created, m.id, p.id
    `).all(sessionId) as Array<{
      message_id: string
      time_created: number
      message_data: string
      part_id?: string
      part_data?: string
    }>

    for (const row of rows) {
      throwIfAborted(signal)
      let message: Record<string, unknown>
      let part: Record<string, unknown> | undefined
      try {
        message = JSON.parse(row.message_data) as Record<string, unknown>
        part = row.part_data === null || row.part_data === undefined
          ? undefined
          : JSON.parse(row.part_data) as Record<string, unknown>
      } catch {
        throw new SessionEventReaderError(
          'SOURCE_FORMAT_INVALID',
          `OpenCode session 数据解析失败：${sessionId}`,
        )
      }
      const role = normalizeRole(message.role)
      const timestamp = timestampOf(asRecord(message.time)?.created, row.time_created)
      const locator = `message:${row.message_id}/part:${row.part_id ?? 'none'}`
      if (part) drafts.push(...contentDrafts(part, role, timestamp, locator))
      else drafts.push(...messageDrafts(message, role, timestamp, `message:${row.message_id}`))
    }
    return drafts
  }, () => afterSnapshot?.(sourcePath, sessionId))
}

function readCopilotTurnEvents(
  dbPath: string,
  sessionId: string,
  signal?: AbortSignal,
  afterSnapshot?: (sourcePath: string, sessionId: string) => void,
): EventReadAttempt {
  return sqliteAttempt(dbPath, (db) => {
    throwIfAborted(signal)
    const turns = db.prepare(`
      SELECT turn_index, user_message, assistant_response, timestamp
      FROM turns
      WHERE session_id = ?
      ORDER BY turn_index
    `).all(sessionId) as Array<{
      turn_index: number
      user_message?: unknown
      assistant_response?: unknown
      timestamp?: unknown
    }>
    return turns.flatMap((turn): EventDraft[] => {
      const timestamp = timestampOf(turn.timestamp)
      const drafts: EventDraft[] = []
      if (turn.user_message !== null && turn.user_message !== undefined) {
        drafts.push(...contentDrafts(
          turn.user_message,
          'user',
          timestamp,
          `turn:${turn.turn_index}.user_message`,
        ))
      }
      if (turn.assistant_response !== null && turn.assistant_response !== undefined) {
        drafts.push(...contentDrafts(
          turn.assistant_response,
          'assistant',
          timestamp,
          `turn:${turn.turn_index}.assistant_response`,
        ))
      }
      return drafts
    })
  }, () => afterSnapshot?.(dbPath, sessionId))
}

async function readStoredSession(
  session: StoredSessionRow,
  options: SessionEventReaderOptions,
  deps: SessionEventReaderDeps,
): Promise<EventReadAttempt> {
  if (JSONL_AGENTS.has(session.agent)) {
    return readJsonlEvents(
      session.source_path,
      session.agent,
      options.signal,
      deps.afterJsonlSnapshot,
    )
  }
  if (session.agent === 'opencode') {
    return readOpenCodeEvents(
      session.source_path,
      session.id,
      options.signal,
      deps.afterSqliteSnapshot,
    )
  }
  if (session.agent === 'copilot') {
    const eventsPath = path.basename(session.source_path) === 'events.jsonl'
      ? session.source_path
      : path.join(path.dirname(session.source_path), 'events.jsonl')
    if (fs.existsSync(eventsPath)) {
      return readJsonlEvents(eventsPath, 'copilot', options.signal, deps.afterJsonlSnapshot)
    }
    const store = findCopilotStore(session.source_path)
    if (store) {
      return readCopilotTurnEvents(
        store,
        session.id,
        options.signal,
        deps.afterSqliteSnapshot,
      )
    }
    throw sourceMissing('copilot', session.source_path)
  }
  throw new SessionEventReaderError(
    'SOURCE_READ_FAILED',
    `Session Event Reader 不支持 Agent：${session.agent}`,
  )
}

function loadSessions(
  references: SessionEventReference[],
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

function result(
  reference: SessionEventReference,
  status: SessionSourceStatus,
  events: SessionEvent[] = [],
  details: Pick<
    SessionEventReadResult,
    'projectSlug' | 'sourceRevision' | 'errorCode' | 'errorMessage'
  > = {},
): SessionEventReadResult {
  return {
    sessionId: reference.id,
    agent: reference.agent,
    status,
    eventCount: events.length,
    events,
    ...details,
  }
}

export async function readSessionEventSources(
  references: SessionEventReference[],
  options: SessionEventReaderOptions = {},
  deps: SessionEventReaderDeps = {},
): Promise<SessionEventReadResult[]> {
  const sessions = loadSessions(references, options.homeDir)
  const results: SessionEventReadResult[] = []
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
        errorMessage: `session ${reference.id} 的 Agent 是 ${session.agent}，不是 ${reference.agent}`,
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
      const attempt = await readStoredSession(session, options, deps)
      if (attempt.events.length === 0) {
        results.push(result(reference, 'empty', [], {
          projectSlug: session.slug,
          sourceRevision: attempt.sourceRevision,
          errorCode: 'SOURCE_EMPTY',
          errorMessage: `session 没有可识别事件：${reference.id}`,
        }))
      } else {
        results.push(result(reference, 'readable', attempt.events, {
          projectSlug: session.slug,
          sourceRevision: attempt.sourceRevision,
        }))
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      const readerError = error instanceof SessionEventReaderError
        ? error
        : new SessionEventReaderError('SOURCE_READ_FAILED', String(error))
      results.push(result(
        reference,
        readerError.code === 'SOURCE_NOT_FOUND' ? 'unavailable' : 'failed',
        [],
        {
          projectSlug: session.slug,
          sourceRevision: readerError.sourceRevision,
          errorCode: readerError.code,
          errorMessage: readerError.message,
        },
      ))
    }
  }
  return results
}
