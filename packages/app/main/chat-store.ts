import fs from 'node:fs'
import path from 'node:path'
import type {
  EvidenceSnapshot,
  GenerationRequest,
  GenerationStatus,
} from './generation-controller.js'
import type { ProjectGenerationResponse } from '../../core/src/commands/rules-generate.js'
import type { RunState } from './background-run.js'

export type ChatThreadStatus = Exclude<RunState, 'idle'>

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  kind: 'rules-generation-request' | 'assistant-response'
  content: string
  status: 'completed' | 'streaming' | 'cancelled' | 'failed' | 'interrupted'
  createdAt: string
  completedAt?: string
}

export interface ChatThreadSummary {
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

export interface ChatThread extends ChatThreadSummary {
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

interface ChatThreadFile extends Omit<ChatThread, 'messages'> {
  version: 1
}

export interface CreateGenerationThreadInput {
  runId: string
  request: GenerationRequest
  startedAt: string
}

const THREAD_FILE = 'thread.json'
const MESSAGES_FILE = 'messages.jsonl'
const PARTIAL_FILE = 'assistant.partial.json'

export class ChatStore {
  constructor(private readonly chatsDir: string) {}

  createGenerationThread(input: CreateGenerationThreadInput): void {
    validateThreadId(input.runId)
    fs.mkdirSync(this.chatsDir, { recursive: true })
    const directory = this.threadDirectory(input.runId)
    fs.mkdirSync(directory, { recursive: true })

    const thread: ChatThreadFile = {
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

  syncGeneration(status: GenerationStatus): void {
    if (!status.runId || status.state === 'idle') return
    const existing = this.readThreadFile(status.runId)
    if (!existing) return
    const now = status.endedAt ?? new Date().toISOString()
    const projectResponses = status.projectResponses.map(cloneProjectResponse)
    const content = assistantContent(projectResponses)
    const thread: ChatThreadFile = {
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
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
        || right.id.localeCompare(left.id),
      )
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

  private readThreadFile(threadId: string): ChatThreadFile | null {
    validateThreadId(threadId)
    const value = readJsonFile<unknown>(
      path.join(this.threadDirectory(threadId), THREAD_FILE),
    )
    if (value === null) return null
    if (!isThreadFile(value, threadId)) {
      throw new Error(`chat thread ${threadId} metadata is invalid`)
    }
    return value
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
          return isChatMessage(value) ? [value] : []
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

function isThreadFile(value: unknown, expectedId: string): value is ChatThreadFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<ChatThreadFile>
  return record.version === 1
    && record.id === expectedId
    && record.runId === expectedId
    && record.kind === 'rules-generation'
    && typeof record.title === 'string'
    && typeof record.status === 'string'
    && Boolean(record.request)
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    && Array.isArray(record.projectResponses)
    && Array.isArray(record.activities)
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

function toSummary(thread: ChatThreadFile): ChatThreadSummary {
  const {
    evidence: _evidence,
    projectResponses: _responses,
    activities: _activities,
    error: _error,
    version: _version,
    ...summary
  } = thread
  return summary
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
): ChatThread['activities'] {
  const activities = new Map<string, ChatThread['activities'][number]>()
  for (const envelope of events) {
    const event = envelope.event
    let activity: ChatThread['activities'][number]
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
