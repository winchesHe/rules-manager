import Database from 'better-sqlite3'
import fs from 'node:fs'
import { redactSecrets } from './redaction.js'
import { resolveWorkspace } from './workspace.js'
import { throwIfAborted } from './abort.js'
import { resolveSessionDisplayNames } from './session-context.js'
import {
  readSessionSources,
  type SessionSourceReadResult,
} from './session-source-reader.js'
import type { AgentName } from './types.js'

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

export type EvidenceKind = 'user_signal' | 'assistant_context'

export interface EvidenceExcerpt {
  locator: {
    sessionId: string
    agent: string
    messageIndex: number
    timestamp?: string
  }
  role: 'user' | 'assistant'
  evidenceKind?: EvidenceKind
  text: string
  tools: EvidenceTool[]
  frequency: number
}

export interface EvidenceBundle {
  projectSlug: string
  sourceSessions: string[]
  roundCount: number
  existingRules?: string[]
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
  displayName: string
  agent: string
  messages: SessionPreviewMessage[]
}

export interface SessionEvidenceContextMessage extends SessionPreviewMessage {
  messageIndex: number
  matched: boolean
}

export interface SessionEvidenceContext {
  sessionId: string
  displayName: string
  agent: string
  messageIndex: number
  eligibility: EvidenceEligibility
  messages: SessionEvidenceContextMessage[]
}

export type EvidenceEligibility =
  | 'eligible'
  | 'existing_rule_baseline'
  | 'platform_context'

export interface SessionEvidenceContextOptions {
  before?: number
  after?: number
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
  agent: AgentName
  slug: string
  source_path: string
  updated_at: string
}

const PRIORITY_KEYWORDS = [
  '必须', '不许', '禁止', '不要', '始终', '总是', '纠正', '应该', '建议', '偏好',
  'must', 'never', 'always', "don't", 'do not', 'should', 'prefer', 'fix', 'error',
]
const MAX_REFERENCED_RULE_BYTES = 256 * 1024
const MAX_REFERENCED_RULE_DEPTH = 3

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

function isPlatformContextOnly(text: string): boolean {
  const normalized = text.trimStart()
  return [
    '<environment_context>',
    '<app-context>',
    '<permissions instructions>',
    '<skills_instructions>',
    '<plugins_instructions>',
    '<recommended_plugins>',
  ].some((prefix) => normalized.startsWith(prefix))
}

function readReferencedRules(
  content: string,
  seen = new Set<string>(),
  depth = 0,
): string[] {
  if (depth >= MAX_REFERENCED_RULE_DEPTH) return []
  const rules: string[] = []
  for (const match of content.matchAll(/^@((?:\/)[^\s，。；;]+)/gm)) {
    const filePath = match[1].replace(/[。,.]+$/u, '')
    if (seen.has(filePath)) continue
    seen.add(filePath)
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile() || stat.size > MAX_REFERENCED_RULE_BYTES) continue
      const referenced = fs.readFileSync(filePath, 'utf8').trim()
      if (!referenced) continue
      rules.push(referenced)
      rules.push(...readReferencedRules(referenced, seen, depth + 1))
    } catch {
      // Missing or unreadable referenced instructions must not block Evidence collection.
    }
  }
  return rules
}

function extractInjectedRuleBaseline(text: string): string[] | undefined {
  const normalized = text.trimStart()
  const agentsHeader = normalized.search(
    /(?:^|\n)# (?:AGENTS|CLAUDE)\.md instructions for /,
  )
  if (agentsHeader < 0) {
    return isPlatformContextOnly(normalized) ? [] : undefined
  }
  if (agentsHeader > 0 && !isPlatformContextOnly(normalized)) return undefined
  const instructions = [...normalized.matchAll(/<INSTRUCTIONS>\s*([\s\S]*?)\s*<\/INSTRUCTIONS>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
  return instructions.flatMap((content) => [
    content,
    ...readReferencedRules(content),
  ])
}

function evidenceEligibility(message: RawEvidenceMessage): EvidenceEligibility {
  if (roleOf(message) !== 'user') return 'eligible'
  const { text } = extractContent(message.content)
  if (extractInjectedRuleBaseline(text) === undefined) return 'eligible'
  return /(?:^|\n)# (?:AGENTS|CLAUDE)\.md instructions for /.test(text.trimStart())
    ? 'existing_rule_baseline'
    : 'platform_context'
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
  const existingRules: string[] = []
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
    for (const item of selected) {
      const { text, tools } = extractContent(item.message.content)
      if (!text.trim() && tools.length === 0) continue
      if (item.role === 'user') {
        const baseline = extractInjectedRuleBaseline(text)
        if (baseline !== undefined) {
          existingRules.push(...baseline)
          continue
        }
      }
      roundCount++
      excerpts.push({
        locator: {
          sessionId: session.sessionId,
          agent: session.agent,
          messageIndex: item.messageIndex,
          ...(typeof item.message.timestamp === 'string' ? { timestamp: item.message.timestamp } : {}),
        },
        role: item.role,
        evidenceKind: item.role === 'user' ? 'user_signal' : 'assistant_context',
        text: text.trim(),
        tools,
        frequency: item.role === 'user' ? 1 : 0,
      })
    }
  }

  const frequencies = new Map<string, Set<string>>()
  for (const excerpt of excerpts) {
    if (excerpt.evidenceKind !== 'user_signal') continue
    const key = normalizeText(excerpt.text)
    if (!key) continue
    const sessionsForText = frequencies.get(key) ?? new Set<string>()
    sessionsForText.add(excerpt.locator.sessionId)
    frequencies.set(key, sessionsForText)
  }
  for (const excerpt of excerpts) {
    excerpt.frequency = excerpt.evidenceKind === 'user_signal'
      ? frequencies.get(normalizeText(excerpt.text))?.size ?? 1
      : 0
  }
  excerpts.sort((left, right) => priority(right.text) - priority(left.text))

  return {
    projectSlug,
    sourceSessions: sourceSessions.map((session) => session.sessionId),
    roundCount,
    existingRules: [...new Set(existingRules)],
    excerpts,
  }
}

const JSONL_AGENTS = new Set(['claude', 'codex', 'cursor', 'pi'])

function legacyEvidenceMessages(
  result: SessionSourceReadResult,
): RawEvidenceMessage[] | undefined {
  if (result.status === 'readable') return result.messages
  if (result.status === 'empty' && !JSONL_AGENTS.has(result.agent)) return []
  return undefined
}

async function loadStoredSessionMessages(
  sessionId: string,
  homeDir?: string,
): Promise<{
  session: Pick<StoredSession, 'id' | 'agent' | 'source_path' | 'slug'>
  rawMessages: RawEvidenceMessage[]
}> {
  if (!sessionId.trim()) throw new Error('session id 不能为空')

  const db = new Database(resolveWorkspace(homeDir).dbPath, {
    readonly: true,
    fileMustExist: true,
  })
  let session: Pick<StoredSession, 'id' | 'agent' | 'source_path' | 'slug'> | undefined
  try {
    session = db.prepare(`
      SELECT id, agent, source_path, slug
      FROM sessions
      WHERE id = ?
    `).get(sessionId) as Pick<StoredSession, 'id' | 'agent' | 'source_path' | 'slug'> | undefined
  } finally {
    db.close()
  }
  if (!session) throw new Error(`session ${sessionId} 不存在`)

  const [readResult] = await readSessionSources(
    [{ agent: session.agent, id: session.id }],
    { homeDir },
  )
  const rawMessages = legacyEvidenceMessages(readResult)
  if (!rawMessages) {
    throw new Error(readResult.errorMessage ?? `session ${readResult.sessionId} 无法读取`)
  }
  return { session, rawMessages }
}

function previewMessagesWithSourceIndex(
  rawMessages: RawEvidenceMessage[],
): Array<SessionPreviewMessage & { messageIndex: number }> {
  return rawMessages
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
    .flatMap<SessionPreviewMessage & { messageIndex: number }>((item) => {
      const { text, tools } = extractContent(item.message.content)
      const trimmedText = text.trim()
      if (!trimmedText && tools.length === 0) return []
      return [{
        role: item.role,
        text: trimmedText,
        messageIndex: item.sourceIndex,
        ...(typeof item.message.timestamp === 'string'
          ? { timestamp: item.message.timestamp }
          : {}),
        tools,
      }]
    })
}

export async function readSessionPreview(
  sessionId: string,
  homeDir?: string,
): Promise<SessionPreview> {
  const { session, rawMessages } = await loadStoredSessionMessages(sessionId, homeDir)
  const messages = previewMessagesWithSourceIndex(rawMessages)
    .map(({ messageIndex: _messageIndex, ...message }) => message)
  const displayName = sessionDisplayName(session)

  return {
    sessionId: session.id,
    displayName,
    agent: session.agent,
    messages,
  }
}

export async function readSessionEvidenceContext(
  sessionId: string,
  messageIndex: number,
  options: SessionEvidenceContextOptions = {},
  homeDir?: string,
): Promise<SessionEvidenceContext> {
  if (!Number.isInteger(messageIndex) || messageIndex < 0) {
    throw new Error('messageIndex 必须是非负整数')
  }
  const before = options.before ?? 2
  const after = options.after ?? 2
  if (!Number.isInteger(before) || before < 0 || before > 10) {
    throw new Error('before 必须是 0 到 10 的整数')
  }
  if (!Number.isInteger(after) || after < 0 || after > 10) {
    throw new Error('after 必须是 0 到 10 的整数')
  }

  const { session, rawMessages } = await loadStoredSessionMessages(sessionId, homeDir)
  const matchedRawMessage = rawMessages[messageIndex]
  if (!matchedRawMessage) {
    throw new Error(`session ${sessionId} 中找不到 Evidence 消息 ${messageIndex}`)
  }
  const visibleMessages = previewMessagesWithSourceIndex(rawMessages)
  const matchedPosition = visibleMessages.findIndex(
    (message) => message.messageIndex === messageIndex,
  )
  if (matchedPosition < 0) {
    throw new Error(`session ${sessionId} 中找不到 Evidence 消息 ${messageIndex}`)
  }
  const messages = visibleMessages
    .slice(
      Math.max(0, matchedPosition - before),
      Math.min(visibleMessages.length, matchedPosition + after + 1),
    )
    .map((message) => ({
      ...message,
      matched: message.messageIndex === messageIndex,
    }))

  return {
    sessionId: session.id,
    displayName: sessionDisplayName(session),
    agent: session.agent,
    messageIndex,
    eligibility: evidenceEligibility(matchedRawMessage),
    messages,
  }
}

function sessionDisplayName(
  session: Pick<StoredSession, 'id' | 'agent' | 'source_path' | 'slug'>,
): string {
  return resolveSessionDisplayNames([{
    id: session.id,
    agent: session.agent,
    sourcePath: session.source_path,
    slug: session.slug,
  }]).get(`${session.agent}\0${session.id}`) ?? `${session.slug} · ${session.agent}`
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
  const readResults = await readSessionSources(
    rows.map((row) => ({ agent: row.agent, id: row.id })),
    {
      homeDir: opts.homeDir,
      signal: opts.signal,
      onVisit: (reference, index) => {
        process.stderr.write(`\r⏳ 读取 session ${index + 1}/${total}（${reference.agent}）`)
      },
    },
  )
  for (const [index, row] of rows.entries()) {
    const readResult = readResults[index]
    const messages = legacyEvidenceMessages(readResult)
    if (!messages) {
      const reason = readResult.errorMessage ?? `session ${readResult.sessionId} 无法读取`
      process.stderr.write('\n')
      console.error(
        `⚠ 跳过 session ${row.id}（${row.agent}）[${readResult.errorCode ?? 'SOURCE_READ_FAILED'}]：${reason}`,
      )
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
