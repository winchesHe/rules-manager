import fs from 'node:fs'
import path from 'node:path'
import type {
  EvidenceSnapshot,
  GenerationRequest,
  GenerationStatus,
} from './generation-controller.js'
import type { ProjectGenerationResponse } from '../../core/src/commands/rules-generate.js'
import type { RunState } from './background-run.js'
import type { NativeToolActivity, NativeTurnTimelineItem } from './chat-runtime.js'
import { canonicalReferences } from './session-context-prompt.js'
import type {
  SessionEvidenceCoverageSummary,
  SessionEvidenceProgress,
} from '../../core/src/live-evidence-engine.js'
import {
  collectSessionExclusions,
  recordInternalSessionExclusion,
} from '../../core/src/session-exclusions.js'

export type ChatThreadStatus = Exclude<RunState, 'idle'>

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  kind: 'rules-generation-request' | 'assistant-response' | 'text'
  content: string
  status: 'completed' | 'streaming' | 'cancelled' | 'failed' | 'interrupted'
  createdAt: string
  completedAt?: string
  turnConfig?: NativeTurnConfig
  attachments?: ChatMessageAttachment[]
  toolActivities?: NativeToolActivity[]
  timeline?: NativeTurnTimelineItem[]
  sessionEvidence?: SessionEvidenceCoverageSummary
}

export interface ChatMessageAttachment {
  kind: 'pasted-text'
  name: string
  characterCount: number
}

export interface GenerationChatThreadSummary {
  version: 1
  id: string
  runId: string
  kind: 'rules-generation'
  title: string
  status: ChatThreadStatus
  request: GenerationRequest
  projectCount: number
  sessionCount: number
  candidateCount: number
  createdAt: string
  updatedAt: string
  endedAt?: string
}

export interface GenerationChatThread extends GenerationChatThreadSummary {
  evidence?: EvidenceSnapshot
  projectResponses: ProjectGenerationResponse[]
  activities: Array<{
    seq: number
    at: string
    kind: string
    id?: string
    label?: string
    detail?: string
    status?: 'running' | 'completed'
  }>
  messages: ChatMessage[]
  error?: string
}

interface GenerationChatThreadFile extends Omit<GenerationChatThread, 'messages'> {}

export type NativeChatProvider = 'claude' | 'codex' | 'opencode' | 'pi'
export type NativeChatEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface NativeTurnConfig {
  model?: string
  effort: NativeChatEffort
  fastMode: boolean
  thinkingOptionId?: string
}

export interface NativeSessionHandle {
  sessionId: string
  nativeHandle?: string
}

export interface NativeSessionReference {
  id: string
  agent: string
}

export interface NativeChatThreadSummary {
  version: 2
  id: string
  kind: 'native-chat'
  title: string
  titleSource: 'first-message' | 'manual'
  origin: 'chat' | 'rules'
  provider: NativeChatProvider
  nativeSessionId: string | null
  nativeSessionHandle: NativeSessionHandle | null
  nativeState: 'starting' | 'ready' | 'start-failed' | 'resume-failed' | 'interrupted' | 'deleted'
  status: 'running' | 'ready' | 'failed' | 'interrupted'
  createdAt: string
  updatedAt: string
  pinnedAt?: string | null
  archivedAt: string | null
  defaultTurnConfig: NativeTurnConfig
  sessionContext: {
    revision: number
    lastInjectedRevision: number
    selected: NativeSessionReference[]
    lastInjectedSelected?: NativeSessionReference[]
  }
  contextUsage: {
    usedTokens: number
    maxTokens: number
    updatedAt: string
  } | null
  lastError: string | null
  activeEvidenceProgress?: SessionEvidenceProgress | null
  runId?: string
  intent?: 'chat' | 'rules-generation'
  rulesArtifact?: {
    runId: string
    projectCount: number
    sessionCount: number
    candidateCount: number
    projectResponses: ProjectGenerationResponse[]
  }
}

export interface NativeChatThread extends NativeChatThreadSummary {
  messages: ChatMessage[]
}

interface NativeChatThreadFile extends Omit<NativeChatThread, 'messages'> {}
type StoredChatThreadFile = GenerationChatThreadFile | NativeChatThreadFile
export type ChatThreadSummary = GenerationChatThreadSummary | NativeChatThreadSummary
export type ChatThread = GenerationChatThread | NativeChatThread

export interface CreateGenerationThreadInput {
  runId: string
  request: GenerationRequest
  startedAt: string
}

export interface CreateNativeThreadInput {
  id: string
  provider: NativeChatProvider
  origin: 'chat' | 'rules'
  title: string
  createdAt: string
  defaultTurnConfig: NativeTurnConfig
  runId?: string
  intent?: 'chat' | 'rules-generation'
}

const THREAD_FILE = 'thread.json'
const MESSAGES_FILE = 'messages.jsonl'
const PARTIAL_FILE = 'assistant.partial.json'

export class ChatStore {
  constructor(private readonly chatsDir: string) {}

  recordInternalEvidenceSession(
    provider: NativeChatProvider,
    nativeSessionId: string,
    at: string,
  ): void {
    recordInternalSessionExclusion(this.chatsDir, { agent: provider, id: nativeSessionId }, at)
  }

  sessionEvidenceExclusions(currentThreadId?: string): NativeSessionReference[] {
    return collectSessionExclusions(this.chatsDir, currentThreadId)
  }

  createGenerationThread(input: CreateGenerationThreadInput): void {
    validateThreadId(input.runId)
    fs.mkdirSync(this.chatsDir, { recursive: true })
    const directory = this.threadDirectory(input.runId)
    fs.mkdirSync(directory, { recursive: true })

    const thread: GenerationChatThreadFile = {
      version: 1,
      id: input.runId,
      runId: input.runId,
      kind: 'rules-generation',
      title: generationTitle(input.request),
      status: 'running',
      request: cloneRequest(input.request),
      projectCount: input.request.mode === 'projects' ? input.request.projects.length : 0,
      sessionCount: 0,
      candidateCount: 0,
      createdAt: input.startedAt,
      updatedAt: input.startedAt,
      projectResponses: [],
      activities: [],
    }
    atomicWriteJson(path.join(directory, THREAD_FILE), thread)

    const messagesPath = path.join(directory, MESSAGES_FILE)
    if (!fs.existsSync(messagesPath) || fs.statSync(messagesPath).size === 0) {
      appendJsonLine(messagesPath, {
        id: `${input.runId}-request`,
        role: 'user',
        kind: 'rules-generation-request',
        content: generationRequestContent(input.request),
        status: 'completed',
        createdAt: input.startedAt,
        completedAt: input.startedAt,
      } satisfies ChatMessage)
    }
  }

  createNativeThread(input: CreateNativeThreadInput): void {
    validateThreadId(input.id)
    fs.mkdirSync(this.chatsDir, { recursive: true })
    const directory = this.threadDirectory(input.id)
    if (fs.existsSync(path.join(directory, THREAD_FILE))) {
      throw new Error(`chat thread ${input.id} already exists`)
    }
    fs.mkdirSync(directory, { recursive: true })
    const thread: NativeChatThreadFile = {
      version: 2,
      id: input.id,
      kind: 'native-chat',
      title: input.title,
      titleSource: 'first-message',
      origin: input.origin,
      provider: input.provider,
      nativeSessionId: null,
      nativeSessionHandle: null,
      nativeState: 'starting',
      status: 'running',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      pinnedAt: null,
      archivedAt: null,
      defaultTurnConfig: { ...input.defaultTurnConfig },
      sessionContext: {
        revision: 0, lastInjectedRevision: 0, selected: [], lastInjectedSelected: [],
      },
      contextUsage: null,
      lastError: null,
      activeEvidenceProgress: null,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.intent ? { intent: input.intent } : {}),
    }
    atomicWriteJson(path.join(directory, THREAD_FILE), thread)
  }

  appendNativeMessage(threadId: string, message: ChatMessage): void {
    const thread = this.requireNativeThread(threadId)
    appendJsonLine(path.join(this.threadDirectory(threadId), MESSAGES_FILE), message)
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      updatedAt: message.completedAt ?? message.createdAt,
    } satisfies NativeChatThreadFile)
  }

  bindNativeSession(threadId: string, input: string | NativeSessionHandle, at: string): void {
    const handle = typeof input === 'string' ? { sessionId: input } : { ...input }
    if (!handle.sessionId.trim()) throw new Error('native session id is required')
    const thread = this.requireNativeThread(threadId)
    if (thread.nativeSessionId && thread.nativeSessionId !== handle.sessionId) {
      throw new Error('native session id cannot be replaced')
    }
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      nativeSessionId: handle.sessionId,
      nativeSessionHandle: handle,
      nativeState: 'ready',
      status: 'ready',
      updatedAt: at,
      lastError: null,
      activeEvidenceProgress: null,
    } satisfies NativeChatThreadFile)
  }

  markNativeTurnRunning(threadId: string, config: NativeTurnConfig, at: string): void {
    const thread = this.requireNativeThread(threadId)
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      status: 'running',
      nativeState: thread.nativeSessionId ? thread.nativeState : 'starting',
      updatedAt: at,
      defaultTurnConfig: { ...config },
      lastError: null,
      activeEvidenceProgress: null,
    } satisfies NativeChatThreadFile)
  }

  updateNativeEvidenceProgress(
    threadId: string,
    progress: SessionEvidenceProgress,
    at: string,
  ): void {
    const thread = this.requireNativeThread(threadId)
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      updatedAt: at,
      activeEvidenceProgress: {
        ...progress,
        ...(progress.coverage ? { coverage: { ...progress.coverage } } : {}),
      },
    } satisfies NativeChatThreadFile)
  }

  markNativeTurnFailed(threadId: string, error: string, at: string): void {
    const thread = this.requireNativeThread(threadId)
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      status: 'failed',
      nativeState: thread.nativeSessionId ? 'resume-failed' : 'start-failed',
      updatedAt: at,
      lastError: error,
      activeEvidenceProgress: null,
    } satisfies NativeChatThreadFile)
  }

  markNativeTurnInterrupted(threadId: string, at: string): void {
    const thread = this.requireNativeThread(threadId)
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      status: 'interrupted',
      nativeState: thread.nativeSessionId ? thread.nativeState : 'interrupted',
      updatedAt: at,
      lastError: null,
      activeEvidenceProgress: null,
    } satisfies NativeChatThreadFile)
  }

  completeNativeRulesRun(
    threadId: string,
    artifact: NonNullable<NativeChatThreadFile['rulesArtifact']>,
    at: string,
  ): void {
    const thread = this.requireNativeThread(threadId)
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      status: 'ready',
      nativeState: thread.nativeSessionId ? 'ready' : thread.nativeState,
      updatedAt: at,
      lastError: null,
      rulesArtifact: {
        ...artifact,
        projectResponses: artifact.projectResponses.map(cloneProjectResponse),
      },
    } satisfies NativeChatThreadFile)
  }

  updateContextUsage(
    threadId: string,
    usage: { usedTokens: number; maxTokens: number },
    at: string,
  ): void {
    const thread = this.requireNativeThread(threadId)
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      contextUsage: { ...usage, updatedAt: at },
      updatedAt: at,
    } satisfies NativeChatThreadFile)
  }

  setNativeSessionContext(
    threadId: string,
    references: NativeSessionReference[],
    at: string,
  ): NativeChatThreadFile['sessionContext'] {
    const thread = this.requireNativeThread(threadId)
    const selected = canonicalReferences(references)
    if (sameReferences(thread.sessionContext.selected, selected)) return thread.sessionContext
    const sessionContext = {
      ...thread.sessionContext,
      revision: thread.sessionContext.revision + 1,
      selected,
      lastInjectedSelected: thread.sessionContext.lastInjectedSelected ?? [],
    }
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      sessionContext,
      updatedAt: at,
    } satisfies NativeChatThreadFile)
    return sessionContext
  }

  markNativeSessionContextInjected(
    threadId: string,
    revision: number,
    references: NativeSessionReference[],
    at: string,
  ): void {
    const thread = this.requireNativeThread(threadId)
    if (!Number.isInteger(revision) || revision < 1 || revision > thread.sessionContext.revision) {
      throw new Error('session context revision is invalid')
    }
    if (revision < thread.sessionContext.lastInjectedRevision) return
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      sessionContext: {
        ...thread.sessionContext,
        lastInjectedRevision: revision,
        lastInjectedSelected: canonicalReferences(references),
      },
      updatedAt: at,
    } satisfies NativeChatThreadFile)
  }

  renameNativeThread(threadId: string, title: string, at: string): void {
    const normalized = title.replace(/\s+/g, ' ').trim()
    if (!normalized) throw new Error('chat title is required')
    const thread = this.requireNativeThread(threadId)
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      title: normalized.slice(0, 120),
      titleSource: 'manual',
      updatedAt: at,
    } satisfies NativeChatThreadFile)
  }

  pinNativeThread(threadId: string, at: string): void {
    const thread = this.requireNativeThread(threadId)
    if (thread.pinnedAt) return
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      pinnedAt: at,
    } satisfies NativeChatThreadFile)
  }

  unpinNativeThread(threadId: string): void {
    const thread = this.requireNativeThread(threadId)
    if (!thread.pinnedAt) return
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      pinnedAt: null,
    } satisfies NativeChatThreadFile)
  }

  archiveNativeThread(threadId: string, at: string): void {
    const thread = this.requireNativeThread(threadId)
    if (thread.archivedAt) return
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      archivedAt: at,
      updatedAt: at,
    } satisfies NativeChatThreadFile)
  }

  unarchiveNativeThread(threadId: string, at: string): void {
    const thread = this.requireNativeThread(threadId)
    if (!thread.archivedAt) return
    atomicWriteJson(path.join(this.threadDirectory(threadId), THREAD_FILE), {
      ...thread,
      archivedAt: null,
      updatedAt: at,
    } satisfies NativeChatThreadFile)
  }

  deleteArchivedNativeThread(threadId: string): void {
    const thread = this.requireNativeThread(threadId)
    if (!thread.archivedAt) throw new Error('native chat must be archived before deletion')
    fs.rmSync(this.threadDirectory(threadId), { recursive: true })
  }

  syncGeneration(status: GenerationStatus): void {
    if (!status.runId || status.state === 'idle') return
    const existing = this.readThreadFile(status.runId)
    if (!existing) return
    const now = status.endedAt ?? new Date().toISOString()
    const projectResponses = status.projectResponses.map(cloneProjectResponse)
    const content = assistantContent(projectResponses)
    if (existing.version !== 1) return
    const thread: GenerationChatThreadFile = {
      ...existing,
      status: status.state,
      request: status.request ? cloneRequest(status.request) : existing.request,
      projectCount: status.evidence?.projects.length ?? existing.projectCount,
      sessionCount: status.evidence?.totalSessions ?? existing.sessionCount,
      candidateCount:
        status.progress?.candidateCount
        ?? projectResponses.reduce((total, response) => total + response.candidates.length, 0),
      updatedAt: now,
      ...(status.endedAt ? { endedAt: status.endedAt } : {}),
      ...(status.evidence ? { evidence: cloneEvidence(status.evidence) } : {}),
      projectResponses,
      activities: status.events.length > 0
        ? buildActivities(status.events)
        : existing.activities,
      ...(status.error ? { error: status.error } : {}),
    }
    atomicWriteJson(
      path.join(this.threadDirectory(status.runId), THREAD_FILE),
      thread,
    )

    const terminal = ['completed', 'cancelled', 'failed', 'interrupted']
      .includes(status.state)
    const partialPath = path.join(this.threadDirectory(status.runId), PARTIAL_FILE)
    const partial: ChatMessage = {
      id: `${status.runId}-assistant`,
      role: 'assistant',
      kind: 'assistant-response',
      content: content || terminalFallback(status),
      status: terminal ? terminalMessageStatus(status.state) : 'streaming',
      createdAt: status.startedAt ?? existing.createdAt,
      ...(terminal ? { completedAt: status.endedAt ?? now } : {}),
    }

    if (terminal) {
      if (!this.readMessages(status.runId).some((message) => message.id === partial.id)) {
        appendJsonLine(
          path.join(this.threadDirectory(status.runId), MESSAGES_FILE),
          partial,
        )
      }
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath)
    } else if (content) {
      atomicWriteJson(partialPath, partial)
    }
  }

  listThreads(limit = 100): ChatThreadSummary[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('chat thread limit must be positive')
    }
    if (!fs.existsSync(this.chatsDir)) return []
    return fs.readdirSync(this.chatsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidThreadId(entry.name))
      .flatMap((entry) => {
        try {
          const thread = this.readThreadFile(entry.name)
          return thread ? [toSummary(thread)] : []
        } catch {
          return []
        }
      })
      .sort(compareThreadSummaries)
      .slice(0, limit)
  }

  readThread(threadId: string): ChatThread | null {
    validateThreadId(threadId)
    const thread = this.readThreadFile(threadId)
    if (!thread) return null
    const partial = readJsonFile<ChatMessage>(
      path.join(this.threadDirectory(threadId), PARTIAL_FILE),
    )
    return {
      ...thread,
      messages: [
        ...this.readMessages(threadId),
        ...(partial ? [partial] : []),
      ],
    }
  }

  markInterruptedThreads(at = new Date().toISOString()): void {
    for (const summary of this.listThreads(Number.MAX_SAFE_INTEGER)) {
      if (summary.status !== 'running' && summary.status !== 'cancelling') continue
      const thread = this.readThread(summary.id)
      if (!thread) continue
      if (thread.version === 2) {
        const stored = this.requireNativeThread(thread.id)
        atomicWriteJson(path.join(this.threadDirectory(thread.id), THREAD_FILE), {
          ...stored,
          status: 'interrupted',
          updatedAt: at,
          lastError: 'Turn was interrupted when the app stopped.',
        } satisfies NativeChatThreadFile)
        continue
      }
      this.syncGeneration({
        running: false,
        state: 'interrupted',
        runId: thread.runId,
        lastSeq: thread.activities.at(-1)?.seq ?? 0,
        request: thread.request,
        evidence: thread.evidence,
        projectResponses: thread.projectResponses,
        events: [],
        output: '',
        outputTruncated: false,
        startedAt: thread.createdAt,
        endedAt: at,
        error: 'Generation was interrupted when the app stopped.',
      })
    }
  }

  private readThreadFile(threadId: string): StoredChatThreadFile | null {
    validateThreadId(threadId)
    const value = readJsonFile<unknown>(
      path.join(this.threadDirectory(threadId), THREAD_FILE),
    )
    if (value === null) return null
    if (!isThreadFile(value, threadId)) {
      throw new Error(`chat thread ${threadId} metadata is invalid`)
    }
    if (value.version === 2) {
      return {
        ...value,
        ...(value.pinnedAt === undefined ? { pinnedAt: null } : {}),
        nativeSessionHandle: value.nativeSessionHandle
          ?? (value.nativeSessionId ? { sessionId: value.nativeSessionId } : null),
      }
    }
    return value
  }

  private requireNativeThread(threadId: string): NativeChatThreadFile {
    const thread = this.readThreadFile(threadId)
    if (!thread || thread.version !== 2) {
      throw new Error(`native chat thread ${threadId} was not found`)
    }
    return thread
  }

  private readMessages(threadId: string): ChatMessage[] {
    const messagesPath = path.join(this.threadDirectory(threadId), MESSAGES_FILE)
    if (!fs.existsSync(messagesPath)) return []
    return fs.readFileSync(messagesPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as unknown
          return isChatMessage(value) ? [visibleChatMessage(value)] : []
        } catch {
          return []
        }
      })
  }

  private threadDirectory(threadId: string): string {
    return path.join(this.chatsDir, threadId)
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
  }
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8')
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function validateThreadId(value: string): void {
  if (!isValidThreadId(value)) throw new Error('invalid chat thread id')
}

function isValidThreadId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
}

function isThreadFile(value: unknown, expectedId: string): value is StoredChatThreadFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<StoredChatThreadFile>
  if (record.version === 2) {
    const native = record as Partial<NativeChatThreadFile>
    return native.id === expectedId
      && native.kind === 'native-chat'
      && (native.provider === 'claude' || native.provider === 'codex'
        || native.provider === 'opencode' || native.provider === 'pi')
      && typeof native.title === 'string'
      && typeof native.createdAt === 'string'
      && typeof native.updatedAt === 'string'
      && (native.pinnedAt === undefined || native.pinnedAt === null || typeof native.pinnedAt === 'string')
      && Boolean(native.defaultTurnConfig)
      && Boolean(native.sessionContext)
  }
  const generation = record as Partial<GenerationChatThreadFile>
  return generation.version === 1
    && generation.id === expectedId
    && generation.runId === expectedId
    && generation.kind === 'rules-generation'
    && typeof generation.title === 'string'
    && typeof generation.status === 'string'
    && Boolean(generation.request)
    && typeof generation.createdAt === 'string'
    && typeof generation.updatedAt === 'string'
    && Array.isArray(generation.projectResponses)
    && Array.isArray(generation.activities)
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<ChatMessage>
  return typeof record.id === 'string'
    && (record.role === 'user' || record.role === 'assistant')
    && typeof record.content === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.status === 'string'
}

function visibleChatMessage(message: ChatMessage): ChatMessage {
  const toolActivities = message.toolActivities?.filter((activity) => {
    const name = activity.name.toLowerCase()
    return name !== 'usermessage' && name !== 'agentmessage'
  })
  const timeline = message.timeline?.filter((item) => {
    if (item.type !== 'tool') return true
    const name = item.activity.name.toLowerCase()
    return name !== 'usermessage' && name !== 'agentmessage'
  })
  return {
    ...message,
    ...(toolActivities ? { toolActivities } : {}),
    ...(timeline ? { timeline } : {}),
  }
}

function sameReferences(
  left: NativeSessionReference[],
  right: NativeSessionReference[],
): boolean {
  const canonicalLeft = canonicalReferences(left)
  return canonicalLeft.length === right.length
    && canonicalLeft.every((reference, index) =>
      reference.agent === right[index]?.agent && reference.id === right[index]?.id,
    )
}

function toSummary(thread: StoredChatThreadFile): ChatThreadSummary {
  if (thread.version === 2) return { ...thread }
  const {
    evidence: _evidence,
    projectResponses: _responses,
    activities: _activities,
    error: _error,
    ...summary
  } = thread
  return summary
}

function compareThreadSummaries(
  left: ChatThreadSummary,
  right: ChatThreadSummary,
): number {
  const leftPinnedAt = left.version === 2 ? left.pinnedAt ?? '' : ''
  const rightPinnedAt = right.version === 2 ? right.pinnedAt ?? '' : ''
  return Number(Boolean(rightPinnedAt)) - Number(Boolean(leftPinnedAt))
    || rightPinnedAt.localeCompare(leftPinnedAt)
    || right.updatedAt.localeCompare(left.updatedAt)
    || right.id.localeCompare(left.id)
}

function generationTitle(request: GenerationRequest): string {
  if (request.mode === 'projects') {
    return request.projects.length === 1
      ? `Rules · ${request.projects[0]}`
      : `Rules · ${request.projects.length} projects`
  }
  if (request.mode === 'full') return 'Rules · Full history'
  return 'Rules · Recent activity'
}

function generationRequestContent(request: GenerationRequest): string {
  if (request.mode === 'projects') {
    return `Generate reusable rules from: ${request.projects.join(', ')}.`
  }
  if (request.mode === 'full') return 'Generate reusable rules from full history.'
  return 'Generate reusable rules from recent activity.'
}

function assistantContent(responses: ProjectGenerationResponse[]): string {
  return responses
    .map((response) => response.summary.trim())
    .filter(Boolean)
    .join('\n\n')
}

function terminalFallback(status: GenerationStatus): string {
  if (status.state === 'completed') return 'Generation completed.'
  if (status.state === 'cancelled') return 'Generation was cancelled.'
  if (status.state === 'failed') return status.error ?? 'Generation failed.'
  if (status.state === 'interrupted') return 'Generation was interrupted.'
  return ''
}

function terminalMessageStatus(
  state: GenerationStatus['state'],
): ChatMessage['status'] {
  if (state === 'cancelled') return 'cancelled'
  if (state === 'failed') return 'failed'
  if (state === 'interrupted') return 'interrupted'
  return 'completed'
}

function cloneRequest(request: GenerationRequest): GenerationRequest {
  return { ...request, projects: [...request.projects] } as GenerationRequest
}

function cloneEvidence(evidence: EvidenceSnapshot): EvidenceSnapshot {
  return {
    ...evidence,
    projects: evidence.projects.map((project) => ({
      ...project,
      sessionIds: [...project.sessionIds],
    })),
  }
}

function cloneProjectResponse(
  response: ProjectGenerationResponse,
): ProjectGenerationResponse {
  return {
    ...response,
    candidates: response.candidates.map((candidate) => ({
      ...candidate,
      evidenceRefs: [...candidate.evidenceRefs],
    })),
  }
}

function buildActivities(
  events: GenerationStatus['events'],
): GenerationChatThread['activities'] {
  const activities = new Map<string, GenerationChatThread['activities'][number]>()
  for (const envelope of events) {
    const event = envelope.event
    let activity: GenerationChatThread['activities'][number]
    if (event.kind === 'activity') {
      activity = {
        seq: envelope.seq,
        at: envelope.at,
        id: event.activity.id,
        kind: event.activity.kind,
        label: event.activity.label,
        ...(event.activity.detail ? { detail: event.activity.detail } : {}),
        ...(event.activity.status ? { status: event.activity.status } : {}),
      }
    } else if (event.kind === 'evidence_ready') {
      activity = {
        seq: envelope.seq,
        at: envelope.at,
        id: 'collect',
        kind: 'collect',
        label: 'Collect',
        detail: `${event.snapshot.totalSessions} sessions · ${event.snapshot.projects.length} projects`,
        status: 'completed',
      }
    } else if (event.kind === 'phase') {
      const { current, total, projectSlug, phase } = event.progress
      if (phase === 'extracting') {
        activity = {
          seq: envelope.seq,
          at: envelope.at,
          id: 'collect',
          kind: 'collect',
          label: 'Collect',
          detail: current !== undefined && total !== undefined
            ? `${current}/${total} evidence bundles`
            : 'Evidence',
          ...(current !== undefined ? { status: 'completed' } : {}),
        }
      } else if (phase === 'done') {
        const failedProjectCount = event.progress.failedProjectCount ?? 0
        activity = {
          seq: envelope.seq,
          at: envelope.at,
          id: 'validate',
          kind: 'validate',
          label: 'Validate',
          detail: `${event.progress.candidateCount ?? 0} candidates${
            failedProjectCount > 0 ? ` · ${failedProjectCount} projects failed` : ''
          }`,
          status: 'completed',
        }
      } else {
        activity = {
          seq: envelope.seq,
          at: envelope.at,
          id: `analyze-${projectSlug ?? phase}`,
          kind: 'analyze',
          label: 'Analyze',
          detail: projectSlug
            ? `${projectSlug}${current !== undefined && total !== undefined
              ? ` · ${current}/${total}`
              : ''}`
            : phase,
        }
      }
    } else if (event.kind === 'project_response') {
      const failed = event.response.status === 'failed'
      activity = {
        seq: envelope.seq,
        at: envelope.at,
        id: `draft-${event.response.projectSlug}`,
        kind: failed ? 'retry' : 'draft',
        label: failed ? 'Failed' : 'Draft',
        detail: failed
          ? `${event.response.projectSlug}: ${
            event.response.error ?? event.response.summary
          }`
          : event.response.projectSlug,
        status: 'completed',
      }
    } else if (event.kind === 'candidate_count') {
      activity = {
        seq: envelope.seq,
        at: envelope.at,
        id: 'validate',
        kind: 'validate',
        label: 'Validate',
        detail: `${event.count} candidates`,
        status: 'completed',
      }
    } else {
      activity = {
        seq: envelope.seq,
        at: envelope.at,
        id: `retry-${envelope.seq}`,
        kind: 'retry',
        label: 'Retry',
        detail: event.message,
      }
    }
    const key = activity.id ?? `${activity.kind}-${activity.seq}`
    const existing = activities.get(key)
    activities.set(key, existing
      ? { ...existing, ...activity, seq: existing.seq, at: existing.at }
      : activity)
  }
  return [...activities.values()]
}
