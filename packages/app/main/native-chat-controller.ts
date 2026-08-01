import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import {
  candidateRulesOutputSchema,
  parseCandidateRulesOutput,
} from '../../core/src/llm.js'
import { runRulesGenerate } from '../../core/src/commands/rules-generate.js'
import type { ProjectGenerationResponse } from '../../core/src/commands/rules-generate.js'
import { getDbPath } from '../../core/src/db.js'
import type { EvidenceBundle } from '../../core/src/evidence.js'
import type {
  EvidenceSnapshot,
  GenerationRequest,
} from './generation-controller.js'
import type {
  ChatMessage,
  ChatStore,
  NativeChatProvider,
  NativeSessionReference,
  NativeTurnConfig,
} from './chat-store.js'
import type {
  ChatRuntimeManager,
  NativeChatEvent,
  NativeToolActivity,
  NativeToolItemPage,
} from './chat-runtime.js'
import { buildSessionContextPrompt } from './session-context-prompt.js'

export interface NativeChatSendRequest {
  chatId?: string
  provider: NativeChatProvider
  message: string
  config: NativeTurnConfig
  sessionContext?: NativeSessionReference[]
}

export interface NativeChatSendResult {
  chatId: string
  nativeSessionId: string
}

export interface NativeChatToolReadRequest {
  chatId: string
  itemId: string
  cursor?: number
  limit?: number
}

export interface NativeChatControllerOptions {
  store: ChatStore
  runtime: ChatRuntimeManager
  workingDirectory: string
  createId?: () => string
  now?: () => string
  onEvent?: (envelope: { chatId: string; event: NativeChatEvent }) => void
  onThreadChanged?: (chatId: string) => void
}

export interface NativeRulesStartResult {
  chatId: string
  runId: string
}

export class NativeChatController {
  private readonly createId: () => string
  private readonly now: () => string

  constructor(private readonly options: NativeChatControllerOptions) {
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async send(request: NativeChatSendRequest): Promise<NativeChatSendResult> {
    const message = request.message.trim()
    if (!message) throw new Error('chat message is required')
    let chatId = request.chatId
    let nativeSessionId: string | null = null
    if (chatId) {
      const thread = this.options.store.readThread(chatId)
      if (!thread || thread.version !== 2) throw new Error('native chat was not found')
      if (thread.provider !== request.provider) throw new Error('chat provider is locked')
      nativeSessionId = thread.nativeSessionId
    } else {
      chatId = this.createId()
      const createdAt = this.now()
      this.options.store.createNativeThread({
        id: chatId,
        provider: request.provider,
        origin: 'chat',
        title: deriveTitle(message),
        createdAt,
        defaultTurnConfig: request.config,
      })
    }

    if (request.sessionContext !== undefined) {
      this.options.store.setNativeSessionContext(chatId, request.sessionContext, this.now())
    }
    const currentThread = this.options.store.readThread(chatId)
    if (!currentThread || currentThread.version !== 2) throw new Error('native chat was not found')
    const contextRevision = currentThread.sessionContext.revision
    const contextSelected = currentThread.sessionContext.selected
    const contextPrompt = contextRevision > currentThread.sessionContext.lastInjectedRevision
      ? buildSessionContextPrompt({
          revision: contextRevision,
          selected: contextSelected,
          previous: currentThread.sessionContext.lastInjectedSelected ?? [],
        })
      : null

    const startedAt = this.now()
    this.options.store.markNativeTurnRunning(chatId, request.config, startedAt)
    this.options.store.appendNativeMessage(chatId, visibleMessage({
      id: randomUUID(),
      role: 'user',
      content: message,
      at: startedAt,
      turnConfig: request.config,
    }))
    const toolActivities = new Map<string, NativeToolActivity>()
    try {
      const result = await this.options.runtime.sendTurn({
        chatId,
        provider: request.provider,
        nativeSessionId,
        message: contextPrompt ? `${contextPrompt}\n\n${message}` : message,
        workingDirectory: this.options.workingDirectory,
        config: request.config,
        onEvent: (event) => {
          if (event.type === 'tool_activity') {
            toolActivities.set(event.activity.itemId, event.activity)
          }
          this.options.onEvent?.({ chatId, event })
        },
      })
      const completedAt = this.now()
      if (contextPrompt) {
        this.options.store.markNativeSessionContextInjected(
          chatId, contextRevision, contextSelected, completedAt,
        )
      }
      this.options.store.bindNativeSession(chatId, result.nativeSessionId, completedAt)
      if (result.contextUsage) {
        this.options.store.updateContextUsage(chatId, result.contextUsage, completedAt)
      }
      this.options.store.appendNativeMessage(chatId, visibleMessage({
        id: randomUUID(),
        role: 'assistant',
        content: result.content,
        at: completedAt,
        toolActivities: [...toolActivities.values()],
      }))
      return { chatId, nativeSessionId: result.nativeSessionId }
    } catch (error) {
      this.options.store.markNativeTurnFailed(chatId, errorMessage(error), this.now())
      throw error
    }
  }

  startRulesGeneration(request: GenerationRequest): NativeRulesStartResult {
    const chatId = this.createId()
    const runId = chatId
    const createdAt = this.now()
    const provider = request.provider ?? 'claude'
    const config: NativeTurnConfig = {
      ...(request.model ? { model: request.model } : {}),
      effort: request.effort ?? 'medium',
      fastMode: request.fastMode ?? false,
    }
    this.options.store.createNativeThread({
      id: chatId,
      provider,
      origin: 'rules',
      title: rulesTitle(request),
      createdAt,
      defaultTurnConfig: config,
      runId,
      intent: 'rules-generation',
    })
    this.options.store.appendNativeMessage(chatId, visibleMessage({
      id: randomUUID(),
      role: 'user',
      content: rulesVisibleRequest(request),
      at: createdAt,
      turnConfig: config,
    }))
    startRunMetadata(runId, request, createdAt)
    void this.runRulesGeneration({ chatId, runId, request, provider, config })
    return { chatId, runId }
  }

  private async runRulesGeneration(input: {
    chatId: string
    runId: string
    request: GenerationRequest
    provider: NativeChatProvider
    config: NativeTurnConfig
  }): Promise<void> {
    let nativeSessionId: string | null = null
    let evidence: EvidenceSnapshot | undefined
    const projectResponses: ProjectGenerationResponse[] = []
    const toolActivities = new Map<string, NativeToolActivity>()
    let firstProviderTurn = true
    let contextRevision = 0
    let contextSelected: NativeSessionReference[] = []
    try {
      await runRulesGenerate({
        ...generationEvidenceOptions(input.request),
        runId: input.runId,
        provider: input.provider,
        model: input.config.model,
        effort: input.config.effort,
        fastMode: input.config.fastMode,
        onEvidence: (bundles) => {
          evidence = evidenceSnapshot(input.request, bundles, this.now())
          contextSelected = evidenceReferences(bundles)
          const context = this.options.store.setNativeSessionContext(
            input.chatId, contextSelected, this.now(),
          )
          contextRevision = context.revision
          updateRunMetadata(input.runId, 'running', input.request, evidence)
          this.options.onThreadChanged?.(input.chatId)
        },
        onProjectResponse: (response) => {
          projectResponses.push(response)
          this.options.onThreadChanged?.(input.chatId)
        },
      }, {
        generate: async (prompt) => {
          const outputSchema = candidateRulesOutputSchema()
          const contextPrompt = firstProviderTurn && contextRevision > 0
            ? buildSessionContextPrompt({
                revision: contextRevision,
                selected: contextSelected,
                previous: [],
              })
            : null
          const result = await this.options.runtime.sendTurn({
            chatId: input.chatId,
            provider: input.provider,
            nativeSessionId,
            message: contextPrompt ? `${contextPrompt}\n\n${prompt}` : prompt,
            workingDirectory: this.options.workingDirectory,
            config: input.config,
            outputSchema,
            onEvent: (event) => {
              if (event.type === 'tool_activity') {
                toolActivities.set(event.activity.itemId, event.activity)
                this.options.onEvent?.({ chatId: input.chatId, event })
              } else if (event.type === 'usage') {
                this.options.onEvent?.({ chatId: input.chatId, event })
              }
            },
          })
          nativeSessionId = result.nativeSessionId
          this.options.store.bindNativeSession(input.chatId, result.nativeSessionId, this.now())
          this.options.store.markNativeTurnRunning(input.chatId, input.config, this.now())
          if (result.contextUsage) {
            this.options.store.updateContextUsage(input.chatId, result.contextUsage, this.now())
          }
          if (firstProviderTurn && contextRevision > 0) {
            this.options.store.markNativeSessionContextInjected(
              input.chatId, contextRevision, contextSelected, this.now(),
            )
          }
          firstProviderTurn = false
          return parseCandidateRulesOutput(
            result.structuredOutput ?? JSON.parse(result.content),
          )
        },
      })
      const completedAt = this.now()
      const candidateCount = projectResponses.reduce(
        (count, response) => count + response.candidates.length, 0,
      )
      this.options.store.appendNativeMessage(input.chatId, visibleMessage({
        id: randomUUID(),
        role: 'assistant',
        content: rulesArtifactSummary(projectResponses, candidateCount),
        at: completedAt,
        toolActivities: [...toolActivities.values()],
      }))
      this.options.store.completeNativeRulesRun(input.chatId, {
        runId: input.runId,
        projectCount: evidence?.projects.length ?? projectResponses.length,
        sessionCount: evidence?.totalSessions ?? 0,
        candidateCount,
        projectResponses,
      }, completedAt)
      updateRunMetadata(input.runId, 'completed', input.request, evidence, candidateCount)
    } catch (error) {
      const message = errorMessage(error)
      const failedAt = this.now()
      this.options.store.markNativeTurnFailed(input.chatId, message, failedAt)
      this.options.store.appendNativeMessage(input.chatId, visibleMessage({
        id: randomUUID(), role: 'assistant', content: `规则生成失败：${message}`, at: failedAt,
      }))
      updateRunMetadata(input.runId, 'failed', input.request, evidence, 0, message)
    } finally {
      this.options.onThreadChanged?.(input.chatId)
    }
  }

  interrupt(chatId: string): Promise<void> {
    return this.options.runtime.interrupt(chatId)
  }

  updateSessionContext(
    chatId: string,
    references: NativeSessionReference[],
  ): NativeChatThreadSessionContext {
    return this.options.store.setNativeSessionContext(chatId, references, this.now())
  }

  rename(chatId: string, title: string): void {
    this.options.store.renameNativeThread(chatId, title, this.now())
  }

  async archive(chatId: string): Promise<void> {
    const thread = this.requireNativeThread(chatId)
    if (thread.archivedAt) return
    if (thread.status === 'running') await this.options.runtime.interrupt(chatId)
    if (thread.nativeSessionId) {
      await this.options.runtime.archive(chatId, thread.provider, thread.nativeSessionId)
    } else if (thread.provider === 'codex') {
      throw new Error('Codex native thread is unavailable')
    }
    this.options.store.archiveNativeThread(chatId, this.now())
  }

  async unarchive(chatId: string): Promise<void> {
    const thread = this.requireNativeThread(chatId)
    if (!thread.archivedAt) return
    if (thread.nativeSessionId) {
      await this.options.runtime.unarchive(chatId, thread.provider, thread.nativeSessionId)
    } else if (thread.provider === 'codex') {
      throw new Error('Codex native thread is unavailable')
    }
    this.options.store.unarchiveNativeThread(chatId, this.now())
  }

  async deleteArchived(chatId: string): Promise<void> {
    const thread = this.requireNativeThread(chatId)
    if (!thread.archivedAt) throw new Error('native chat must be archived before deletion')
    if (thread.nativeSessionId) {
      await this.options.runtime.delete(chatId, thread.provider, thread.nativeSessionId)
    } else {
      await this.options.runtime.close(chatId)
    }
    this.options.store.deleteArchivedNativeThread(chatId)
  }

  async readToolItem(request: NativeChatToolReadRequest): Promise<NativeToolItemPage> {
    const thread = this.options.store.readThread(request.chatId)
    if (!thread || thread.version !== 2 || !thread.nativeSessionId) {
      throw new Error('native chat was not found')
    }
    const allowed = thread.messages.some((message) =>
      message.toolActivities?.some((activity) => activity.itemId === request.itemId),
    )
    if (!allowed) throw new Error('tool item was not found')
    return this.options.runtime.readToolItem({
      chatId: request.chatId,
      provider: thread.provider,
      nativeSessionId: thread.nativeSessionId,
      itemId: request.itemId,
      cursor: request.cursor ?? 0,
      limit: request.limit ?? 8192,
    })
  }

  private requireNativeThread(chatId: string) {
    const thread = this.options.store.readThread(chatId)
    if (!thread || thread.version !== 2) throw new Error('native chat was not found')
    return thread
  }
}

type NativeChatThreadSessionContext = Extract<
  ReturnType<ChatStore['readThread']>,
  { version: 2 }
>['sessionContext']

function visibleMessage(input: {
  id: string
  role: ChatMessage['role']
  content: string
  at: string
  turnConfig?: NativeTurnConfig
  toolActivities?: NativeToolActivity[]
}): ChatMessage {
  return {
    id: input.id,
    role: input.role,
    kind: 'text',
    content: input.content,
    status: 'completed',
    createdAt: input.at,
    completedAt: input.at,
    ...(input.turnConfig ? { turnConfig: { ...input.turnConfig } } : {}),
    ...(input.toolActivities && input.toolActivities.length > 0
      ? { toolActivities: input.toolActivities.map((activity) => ({ ...activity })) }
      : {}),
  }
}

function deriveTitle(message: string): string {
  return message.replace(/\s+/g, ' ').slice(0, 80)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function generationEvidenceOptions(request: GenerationRequest): {
  projectSlugs?: string[]
  full?: boolean
  updatedSince?: string
} {
  if (request.mode === 'projects') return { projectSlugs: request.projects }
  if (request.mode === 'full') return { full: true }
  if (request.mode === 'changed7d') {
    return { updatedSince: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString() }
  }
  return {}
}

function evidenceSnapshot(
  request: GenerationRequest,
  bundles: EvidenceBundle[],
  createdAt: string,
): EvidenceSnapshot {
  return {
    mode: request.mode,
    projects: bundles.map((bundle) => ({
      slug: bundle.projectSlug,
      sessionIds: [...bundle.sourceSessions],
      roundCount: bundle.roundCount,
      excerptCount: bundle.excerpts.length,
    })),
    totalSessions: new Set(bundles.flatMap((bundle) => bundle.sourceSessions)).size,
    createdAt,
  }
}

function evidenceReferences(bundles: EvidenceBundle[]): NativeSessionReference[] {
  const agents = new Map<string, string>()
  for (const bundle of bundles) {
    for (const excerpt of bundle.excerpts) {
      agents.set(excerpt.locator.sessionId, excerpt.locator.agent)
    }
  }
  return [...new Set(bundles.flatMap((bundle) => bundle.sourceSessions))]
    .map((id) => ({ id, agent: agents.get(id) ?? 'unknown' }))
}

function rulesTitle(request: GenerationRequest): string {
  return request.mode === 'projects'
    ? `生成规则：${request.projects.join(', ')}`.slice(0, 120)
    : `生成规则：${request.mode}`
}

function rulesVisibleRequest(request: GenerationRequest): string {
  if (request.mode === 'projects') {
    return `为项目 ${request.projects.join('、')} 生成可复用的 Agent 规则候选。`
  }
  if (request.mode === 'full') return '基于全部 Session 生成可复用的 Agent 规则候选。'
  if (request.mode === 'changed7d') return '基于最近 7 天更新的 Session 生成可复用的 Agent 规则候选。'
  return '基于最近 Session 生成可复用的 Agent 规则候选。'
}

function rulesArtifactSummary(
  responses: ProjectGenerationResponse[],
  candidateCount: number,
): string {
  const completed = responses.filter((response) => response.status !== 'failed').length
  const failed = responses.length - completed
  return `规则生成完成：${completed} 个项目，${candidateCount} 条候选${failed ? `，${failed} 个项目失败` : ''}。可前往“生成的规则”审核。`
}

function startRunMetadata(runId: string, request: GenerationRequest, startedAt: string): void {
  const db = new Database(getDbPath())
  try {
    db.prepare(`
      INSERT INTO run_metadata (id, run_type, started_at, status, details)
      VALUES (?, 'generate-rules', ?, 'running', ?)
    `).run(runId, startedAt, JSON.stringify({ request }))
  } finally {
    db.close()
  }
}

function updateRunMetadata(
  runId: string,
  status: 'running' | 'completed' | 'failed',
  request: GenerationRequest,
  evidence?: EvidenceSnapshot,
  candidateCount = 0,
  failure?: string,
): void {
  const db = new Database(getDbPath())
  try {
    const details = {
      request,
      evidence: evidence ? {
        projectCount: evidence.projects.length,
        totalSessions: evidence.totalSessions,
        projects: evidence.projects,
        createdAt: evidence.createdAt,
      } : null,
      candidateCount,
      ...(failure ? { failure } : {}),
    }
    db.prepare(`
      UPDATE run_metadata
      SET ended_at = ?, status = ?, details = ?
      WHERE id = ?
    `).run(status === 'running' ? null : new Date().toISOString(), status, JSON.stringify(details), runId)
  } finally {
    db.close()
  }
}
