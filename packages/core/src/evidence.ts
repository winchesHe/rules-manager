import Database from 'better-sqlite3'
import fs from 'node:fs'
import readline from 'node:readline'
import { runSessionsShow } from './commands/sessions.js'
import { collectFilesRecursive } from './adapters/shared.js'
import { redactSecrets } from './redaction.js'
import { resolveWorkspace } from './workspace.js'
import { throwIfAborted } from './abort.js'

export interface RawEvidenceMessage {
  role?: unknown
  content?: unknown
  timestamp?: unknown
  [key: string]: unknown
}

export interface RawEvidenceSession {
  sessionId: string
  agent: string
  messages: RawEvidenceMessage[]
}

export interface EvidenceTool {
  tool: string
  summary: string
}

export interface EvidenceExcerpt {
  locator: {
    sessionId: string
    agent: string
    messageIndex: number
    timestamp?: string
  }
  role: 'user' | 'assistant'
  text: string
  tools: EvidenceTool[]
  frequency: number
}

export interface EvidenceBundle {
  projectSlug: string
  sourceSessions: string[]
  roundCount: number
  excerpts: EvidenceExcerpt[]
}

export interface SessionPreviewMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
  tools: EvidenceTool[]
}

export interface SessionPreview {
  sessionId: string
  agent: string
  messages: SessionPreviewMessage[]
}

export interface EvidenceOptions {
  homeDir?: string
  projectSlug?: string
  projectSlugs?: string[]
  sessionIds?: string[]
  updatedSince?: string
  rounds?: number
  full?: boolean
  signal?: AbortSignal
}

interface StoredSession {
  id: string
  agent: string
  slug: string
  source_path: string
  updated_at: string
}

const PRIORITY_KEYWORDS = [
  '必须', '不许', '禁止', '不要', '始终', '总是', '纠正', '应该', '建议', '偏好',
  'must', 'never', 'always', "don't", 'do not', 'should', 'prefer', 'fix', 'error',
]

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function roleOf(message: RawEvidenceMessage): 'user' | 'assistant' | undefined {
  const role = message.role
  if (role === 'user' || role === 'assistant') return role
  return undefined
}

function summarizeTool(block: Record<string, unknown>): EvidenceTool | undefined {
  const type = typeof block.type === 'string' ? block.type : ''
  if (!['tool_use', 'tool_result', 'function_call'].includes(type)) return undefined
  const name = block.name ?? block.tool_name ?? block.tool ?? block.function
  return {
    tool: typeof name === 'string' && name.trim() ? name : 'unknown',
    summary: type === 'tool_result' ? '工具返回结果' : '调用工具',
  }
}

function extractContent(content: unknown): { text: string; tools: EvidenceTool[] } {
  if (typeof content === 'string') return { text: redactSecrets(content), tools: [] }
  if (!Array.isArray(content)) {
    const record = asRecord(content)
    if (!record) return { text: '', tools: [] }
    const tool = summarizeTool(record)
    if (tool) return { text: '', tools: [tool] }
    return typeof record.text === 'string'
      ? { text: redactSecrets(record.text), tools: [] }
      : { text: '', tools: [] }
  }

  const texts: string[] = []
  const tools: EvidenceTool[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      texts.push(redactSecrets(item))
      continue
    }
    const block = asRecord(item)
    if (!block) continue
    const tool = summarizeTool(block)
    if (tool) {
      tools.push(tool)
    } else if ((block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') {
      texts.push(redactSecrets(block.text))
    }
  }
  return { text: texts.filter(Boolean).join('\n'), tools }
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function priority(text: string): number {
  const lower = text.toLowerCase()
  return PRIORITY_KEYWORDS.reduce((score, keyword) => score + (lower.includes(keyword) ? 1 : 0), 0)
}

function isInternalRulesGenerationSession(session: RawEvidenceSession): boolean {
  return session.messages.some((message) => {
    if (roleOf(message) !== 'user') return false
    const { text } = extractContent(message.content)
    const normalized = text.trimStart()
    return normalized.startsWith('根据 evidence 提取可复用的 agent 规则候选。')
      || (
        normalized.startsWith('为项目 ')
        && normalized.includes('提取可复用的 agent 规则候选。')
        && normalized.includes('Evidence 不在本 Prompt 中')
      )
  })
}

export function buildEvidenceBundle(
  projectSlug: string,
  sessions: RawEvidenceSession[],
  opts: Pick<EvidenceOptions, 'rounds' | 'full'> = {},
): EvidenceBundle {
  const rounds = opts.full || opts.rounds === undefined
    ? Number.POSITIVE_INFINITY
    : opts.rounds
  if (!Number.isInteger(rounds) && rounds !== Number.POSITIVE_INFINITY || rounds <= 0) {
    throw new Error('rounds 必须是正整数')
  }

  const excerpts: EvidenceExcerpt[] = []
  let roundCount = 0
  const sourceSessions = sessions.filter(
    (session) => !isInternalRulesGenerationSession(session),
  )
  for (const session of sourceSessions) {
    const normalized = session.messages
      .map((message, messageIndex) => ({ message, messageIndex, role: roleOf(message) }))
      .filter((item): item is typeof item & { role: 'user' | 'assistant' } => item.role !== undefined)
      .sort((left, right) => {
        const leftTime = typeof left.message.timestamp === 'string' ? Date.parse(left.message.timestamp) : Number.NaN
        const rightTime = typeof right.message.timestamp === 'string' ? Date.parse(right.message.timestamp) : Number.NaN
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
          return leftTime - rightTime
        }
        return left.messageIndex - right.messageIndex
      })
    const selected = rounds === Number.POSITIVE_INFINITY ? normalized : normalized.slice(-rounds)
    roundCount += selected.length
    for (const item of selected) {
      const { text, tools } = extractContent(item.message.content)
      if (!text.trim() && tools.length === 0) continue
      excerpts.push({
        locator: {
          sessionId: session.sessionId,
          agent: session.agent,
          messageIndex: item.messageIndex,
          ...(typeof item.message.timestamp === 'string' ? { timestamp: item.message.timestamp } : {}),
        },
        role: item.role,
        text: text.trim(),
        tools,
        frequency: 1,
      })
    }
  }

  const frequencies = new Map<string, Set<string>>()
  for (const excerpt of excerpts) {
    const key = normalizeText(excerpt.text)
    if (!key) continue
    const sessionsForText = frequencies.get(key) ?? new Set<string>()
    sessionsForText.add(excerpt.locator.sessionId)
    frequencies.set(key, sessionsForText)
  }
  for (const excerpt of excerpts) {
    excerpt.frequency = frequencies.get(normalizeText(excerpt.text))?.size ?? 1
  }
  excerpts.sort((left, right) => priority(right.text) - priority(left.text))

  return {
    projectSlug,
    sourceSessions: sourceSessions.map((session) => session.sessionId),
    roundCount,
    excerpts,
  }
}

function normalizeMessage(value: unknown): RawEvidenceMessage | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const nested = asRecord(record.message) ?? asRecord(record.payload) ?? asRecord(record.info)
  const eventType = typeof record.type === 'string' ? record.type : ''
  const nestedType = typeof nested?.type === 'string' ? nested.type : ''
  let inferredRole: 'user' | 'assistant' | undefined
  if (eventType.startsWith('user.')) {
    inferredRole = 'user'
  } else if (eventType.startsWith('assistant.') || ['tool_use', 'tool_result', 'function_call'].includes(nestedType || eventType)) {
    inferredRole = 'assistant'
  }
  const role = nested?.role ?? record.role ?? inferredRole
  const content = ['tool_use', 'tool_result', 'function_call'].includes(nestedType)
    ? nested
    : nested?.content ?? record.content ?? record.parts ?? record.text
  const timestamp = nested?.timestamp ?? record.timestamp ?? nested?.time ?? record.time
  if (role !== 'user' && role !== 'assistant') return undefined
  return { role, content, timestamp }
}

function messagesFromShown(value: unknown): RawEvidenceMessage[] {
  const shown = asRecord(value)
  if (!shown) return []
  if (Array.isArray(shown.turns)) {
    return shown.turns.flatMap((turn) => {
      const row = asRecord(turn)
      if (!row) return []
      return [
        { role: 'user', content: row.user_message, timestamp: row.timestamp },
        { role: 'assistant', content: row.assistant_response, timestamp: row.timestamp },
      ]
    })
  }
  const values = Array.isArray(shown.records)
    ? shown.records
    : Array.isArray(shown.messages) ? shown.messages : []
  return values.map(normalizeMessage).filter((message): message is RawEvidenceMessage => message !== undefined)
}

const JSONL_AGENTS = new Set(['claude', 'codex', 'cursor', 'pi'])

async function readJsonlSessionDirect(
  sourcePath: string,
  agent: string,
): Promise<RawEvidenceMessage[]> {
  if (!fs.existsSync(sourcePath)) throw new Error(`${agent} session 源不存在：${sourcePath}`)
  const stat = fs.statSync(sourcePath)
  const files = stat.isDirectory()
    ? collectFilesRecursive(sourcePath, (filePath) => filePath.endsWith('.jsonl'))
    : [sourcePath]
  if (files.length === 0) throw new Error(`${agent} session 没有 JSONL 文件：${sourcePath}`)

  const messages: RawEvidenceMessage[] = []
  for (const filePath of files) {
    const lines = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Number.POSITIVE_INFINITY,
    })
    let lineNumber = 0
    for await (const rawLine of lines) {
      lineNumber++
      const line = lineNumber === 1 ? rawLine.replace(/^\uFEFF/, '') : rawLine
      if (!line.trim()) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        throw new Error(`${agent} JSONL 解析失败：${filePath}:${lineNumber}`)
      }
      const message = normalizeMessage(record)
      if (message) messages.push(message)
    }
  }
  if (messages.length === 0) {
    throw new Error(`${agent} session 没有用户或 assistant 消息：${sourcePath}`)
  }
  return messages
}

async function readSessionMessages(
  sessionId: string,
  agent: string,
  sourcePath: string,
  homeDir?: string,
): Promise<RawEvidenceMessage[]> {
  if (JSONL_AGENTS.has(agent)) {
    return readJsonlSessionDirect(sourcePath, agent)
  }
  const output: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => output.push(args.map(String).join(' '))
  try {
    await runSessionsShow(sessionId, { homeDir })
  } finally {
    console.log = originalLog
  }
  if (output.length !== 1) throw new Error(`session ${sessionId} 原文输出格式异常`)
  return messagesFromShown(JSON.parse(output[0]))
}

interface OpenCodeMessageRow {
  msg_data: string
  part_data: string
}

function readOpenCodeSessionDirect(dbPath: string, sessionId: string): RawEvidenceMessage[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare(`
      SELECT m.data AS msg_data, p.data AS part_data
      FROM message m
      JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY m.time_created, p.id
    `).all(sessionId) as OpenCodeMessageRow[]

    const messages: RawEvidenceMessage[] = []
    for (const row of rows) {
      let msgMeta: Record<string, unknown> = {}
      let partContent: Record<string, unknown> = {}
      try { msgMeta = JSON.parse(row.msg_data) } catch { /* ignore */ }
      try { partContent = JSON.parse(row.part_data) } catch { /* ignore */ }

      const role = msgMeta.role as string | undefined
      if (role !== 'user' && role !== 'assistant') continue

      const text = partContent.text ?? partContent.content
      if (typeof text !== 'string' || !text.trim()) continue

      const time = msgMeta.time as Record<string, unknown> | undefined
      const timestamp = time?.created ? String(time.created) : undefined
      messages.push({ role, content: text, timestamp })
    }
    return messages
  } finally {
    db.close()
  }
}

export async function readSessionPreview(
  sessionId: string,
  homeDir?: string,
): Promise<SessionPreview> {
  if (!sessionId.trim()) throw new Error('session id 不能为空')

  const db = new Database(resolveWorkspace(homeDir).dbPath, {
    readonly: true,
    fileMustExist: true,
  })
  let session: Pick<StoredSession, 'id' | 'agent' | 'source_path'> | undefined
  try {
    session = db.prepare(`
      SELECT id, agent, source_path
      FROM sessions
      WHERE id = ?
    `).get(sessionId) as Pick<StoredSession, 'id' | 'agent' | 'source_path'> | undefined
  } finally {
    db.close()
  }
  if (!session) throw new Error(`session ${sessionId} 不存在`)

  const rawMessages = session.agent === 'opencode'
    ? readOpenCodeSessionDirect(session.source_path, session.id)
    : await readSessionMessages(session.id, session.agent, session.source_path, homeDir)
  const messages = rawMessages
    .map((message, sourceIndex) => ({
      message,
      sourceIndex,
      role: roleOf(message),
    }))
    .filter(
      (item): item is typeof item & { role: 'user' | 'assistant' } =>
        item.role !== undefined,
    )
    .sort((left, right) => {
      const leftTime = typeof left.message.timestamp === 'string'
        ? Date.parse(left.message.timestamp)
        : Number.NaN
      const rightTime = typeof right.message.timestamp === 'string'
        ? Date.parse(right.message.timestamp)
        : Number.NaN
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime
      }
      return left.sourceIndex - right.sourceIndex
    })
    .flatMap<SessionPreviewMessage>((item) => {
      const { text, tools } = extractContent(item.message.content)
      const trimmedText = text.trim()
      if (!trimmedText && tools.length === 0) return []
      return [{
        role: item.role,
        text: trimmedText,
        ...(typeof item.message.timestamp === 'string'
          ? { timestamp: item.message.timestamp }
          : {}),
        tools,
      }]
    })

  return {
    sessionId: session.id,
    agent: session.agent,
    messages,
  }
}

export async function extractEvidence(opts: EvidenceOptions = {}): Promise<EvidenceBundle[]> {
  throwIfAborted(opts.signal)
  if (opts.projectSlug && opts.projectSlugs !== undefined) {
    throw new Error('projectSlug 与 projectSlugs 不能同时使用')
  }
  if (
    opts.projectSlugs !== undefined
    && (
      opts.projectSlugs.length === 0
      || opts.projectSlugs.some((slug) => !slug.trim())
    )
  ) {
    throw new Error('projectSlugs 必须包含至少一个非空项目')
  }
  const db = new Database(resolveWorkspace(opts.homeDir).dbPath, { readonly: true, fileMustExist: true })
  let rows: StoredSession[]
  try {
    rows = (opts.projectSlug
      ? db.prepare("SELECT id, agent, slug, source_path, updated_at FROM sessions WHERE slug = ? AND status != 'missing' ORDER BY id").all(opts.projectSlug)
      : db.prepare("SELECT id, agent, slug, source_path, updated_at FROM sessions WHERE status != 'missing' ORDER BY slug, id").all()) as StoredSession[]
    if (opts.projectSlugs !== undefined) {
      const selectedSlugs = new Set(opts.projectSlugs)
      rows = rows.filter((row) => selectedSlugs.has(row.slug))
    }
    if (opts.sessionIds !== undefined) {
      const selectedIds = new Set(opts.sessionIds)
      rows = rows.filter((row) => selectedIds.has(row.id))
    }
    if (opts.updatedSince !== undefined) {
      const cutoff = Date.parse(opts.updatedSince)
      if (!Number.isFinite(cutoff)) throw new Error('updatedSince 必须是有效时间')
      rows = rows.filter((row) => {
        const updatedAt = Date.parse(row.updated_at)
        return Number.isFinite(updatedAt) && updatedAt >= cutoff
      })
    }
  } finally {
    db.close()
  }

  const grouped = new Map<string, RawEvidenceSession[]>()
  const total = rows.length
  for (let i = 0; i < rows.length; i++) {
    throwIfAborted(opts.signal)
    const row = rows[i]
    process.stderr.write(`\r⏳ 读取 session ${i + 1}/${total}（${row.agent}）`)
    let messages: RawEvidenceMessage[]
    try {
      if (row.agent === 'opencode') {
        messages = readOpenCodeSessionDirect(row.source_path, row.id)
      } else {
        messages = await readSessionMessages(
          row.id,
          row.agent,
          row.source_path,
          opts.homeDir,
        )
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write('\n')
      console.error(`⚠ 跳过 session ${row.id}（${row.agent}）：${reason}`)
      continue
    }
    throwIfAborted(opts.signal)
    const sessions = grouped.get(row.slug) ?? []
    sessions.push({ sessionId: row.id, agent: row.agent, messages })
    grouped.set(row.slug, sessions)
  }
  if (total > 0) process.stderr.write('\n')
  throwIfAborted(opts.signal)
  return [...grouped.entries()].map(([slug, sessions]) => buildEvidenceBundle(slug, sessions, opts))
}
