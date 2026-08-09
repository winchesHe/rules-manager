import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import Database from 'better-sqlite3'
import { collectFilesRecursive } from './adapters/shared.js'
import { throwIfAborted } from './abort.js'
import type {
  SessionEvidenceReference,
  SessionSourceStatus,
} from './evidence-coverage.js'
import { resolveWorkspace } from './workspace.js'
import type { AgentName, SessionStatus } from './types.js'

export interface SessionSourceMessage {
  role: 'user' | 'assistant'
  content: unknown
  timestamp?: unknown
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
  errorCode?: SessionSourceErrorCode
  errorMessage?: string
}

export interface SessionSourceReaderOptions {
  homeDir?: string
  signal?: AbortSignal
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
  ) {
    super(message)
  }
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

async function readJsonlMessages(
  sourcePath: string,
  agent: AgentName,
  signal?: AbortSignal,
): Promise<SessionSourceMessage[]> {
  if (!fs.existsSync(sourcePath)) throw sourceMissing(agent, sourcePath)
  const files = fs.statSync(sourcePath).isDirectory()
    ? collectFilesRecursive(sourcePath, (filePath) => filePath.endsWith('.jsonl'))
    : [sourcePath]
  const messages: SessionSourceMessage[] = []
  for (const filePath of files) {
    const input = fs.createReadStream(filePath, { encoding: 'utf8' })
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
            `${agent} JSONL 解析失败：${filePath}:${lineNumber}`,
          )
        }
        const message = normalizeMessage(record)
        if (message) messages.push(message)
      }
    } finally {
      lines.close()
      input.destroy()
    }
  }
  return messages
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
  sessionId: string,
  sourcePath: string,
  signal?: AbortSignal,
): Promise<SessionSourceMessage[]> {
  const eventsPath = path.basename(sourcePath) === 'events.jsonl'
    ? sourcePath
    : path.join(path.dirname(sourcePath), 'events.jsonl')
  if (fs.existsSync(eventsPath)) {
    return readJsonlMessages(eventsPath, 'copilot', signal)
  }

  const storePath = findCopilotStore(sourcePath)
  if (!storePath) throw sourceMissing('copilot', sourcePath)
  throwIfAborted(signal)
  const db = new Database(storePath, { readonly: true, fileMustExist: true })
  try {
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
  } finally {
    db.close()
  }
}

function readOpenCodeMessages(
  sessionId: string,
  sourcePath: string,
  signal?: AbortSignal,
): SessionSourceMessage[] {
  if (!fs.existsSync(sourcePath)) throw sourceMissing('opencode', sourcePath)
  throwIfAborted(signal)
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
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
  } finally {
    db.close()
  }
}

async function readMessages(
  session: StoredSessionRow,
  signal?: AbortSignal,
): Promise<SessionSourceMessage[]> {
  if (JSONL_AGENTS.has(session.agent)) {
    return readJsonlMessages(session.source_path, session.agent, signal)
  }
  if (session.agent === 'copilot') {
    return readCopilotMessages(session.id, session.source_path, signal)
  }
  return readOpenCodeMessages(session.id, session.source_path, signal)
}

function result(
  reference: SessionEvidenceReference,
  status: SessionSourceStatus,
  messages: SessionSourceMessage[] = [],
  details: Pick<SessionSourceReadResult, 'projectSlug' | 'errorCode' | 'errorMessage'> = {},
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
): Promise<SessionSourceReadResult[]> {
  const sessions = loadSessions(references, options.homeDir)
  const results: SessionSourceReadResult[] = []
  for (const reference of references) {
    throwIfAborted(options.signal)
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
      const messages = await readMessages(session, options.signal)
      results.push(messages.length > 0
        ? result(reference, 'readable', messages, { projectSlug: session.slug })
        : result(reference, 'empty', [], {
          projectSlug: session.slug,
          errorCode: 'SOURCE_EMPTY',
          errorMessage: `session 源中没有可用对话：${reference.id}`,
        }))
    } catch (error) {
      if (options.signal?.aborted) throw error
      const knownError = error instanceof SourceReaderError ? error : undefined
      results.push(result(reference, knownError?.code === 'SOURCE_NOT_FOUND' ? 'unavailable' : 'failed', [], {
        projectSlug: session.slug,
        errorCode: knownError?.code ?? 'SOURCE_READ_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
      }))
    }
  }
  return results
}
