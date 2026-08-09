import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import {
  runLiveSessionEvidence,
  type SessionEvidenceCoverageSummary,
} from '../../core/src/live-evidence-engine.js'
import {
  planSessionEvidence,
  type SessionEvidenceRequestMode,
} from '../../core/src/live-evidence-planner.js'
import type { AgentName } from '../../core/src/types.js'
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
  NativeSessionHandle,
  NativeTurnConfig,
} from './chat-store.js'
import type { NativePastedTextAttachment } from './pasted-text-validation.js'
import type {
  ChatRuntimeManager,
  NativeChatEvent,
  NativeToolActivity,
  NativeToolItemPage,
  NativeTurnResult,
  NativeTurnTimelineItem,
} from './chat-runtime.js'
import { NativeEvidenceModelRunner } from './evidence-model-runner.js'
import { buildSessionContextPrompt } from './session-context-prompt.js'
import { prepareSessionContextInput } from './session-context-input.js'
import {
  completeNativeTimeline,
  mergeNativeTimelineEvent,
} from './native-chat-timeline.js'

export interface NativeChatSendRequest {
  chatId?: string
  provider: NativeChatProvider
  message: string
  config: NativeTurnConfig
  sessionContext?: NativeSessionReference[]
  sessionEvidenceMode?: SessionEvidenceRequestMode
  pastedTextAttachments?: NativePastedTextAttachment[]
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
  onTurnCompleted?: (chatId: string) => void
  enableSessionEvidence?: boolean
  sessionEvidenceHomeDir?: string
  sessionEvidenceTempParentDir?: string
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
    const pastedTextAttachments = request.pastedTextAttachments ?? []
    if (!message && pastedTextAttachments.length === 0) throw new Error('chat message is required')
    if (pastedTextAttachments.length > 0 && request.provider !== 'codex') {
      throw new Error('pasted text attachments require Codex')
    }
    let chatId = request.chatId
    let nativeSessionId: string | null = null
    let nativeSessionHandle: NativeSessionHandle | null = null
    if (chatId) {
      const thread = this.options.store.readThread(chatId)
      if (!thread || thread.version !== 2) throw new Error('native chat was not found')
      if (thread.provider !== request.provider) throw new Error('chat provider is locked')
      nativeSessionId = thread.nativeSessionId
      nativeSessionHandle = thread.nativeSessionHandle
    } else {
      chatId = this.createId()
      const createdAt = this.now()
      this.options.store.createNativeThread({
        id: chatId,
        provider: request.provider,
        origin: 'chat',
        title: deriveTitle(message || pastedTextAttachments[0]?.name || 'Pasted text'),
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
      attachments: pastedTextAttachments.map(({ name, characterCount }) => ({
        kind: 'pasted-text' as const,
        name,
        characterCount,
      })),
    }))
    this.options.onThreadChanged?.(chatId)
    let timeline: NativeTurnTimelineItem[] = []
    let evidenceSummary: SessionEvidenceCoverageSummary | undefined
    try {
      const evidencePlan = this.options.enableSessionEvidence && pastedTextAttachments.length === 0
        ? planSessionEvidence({
            runId: `${chatId}:evidence:${randomUUID()}`,
            question: message,
            selected: contextSelected.map((reference) => ({
              id: reference.id,
              agent: evidenceAgent(reference.agent),
            })),
            mode: request.sessionEvidenceMode ?? 'auto',
          })
        : null
      let result: NativeTurnResult
      let assistantContent: string
      if (evidencePlan) {
        let reduceResult: NativeTurnResult | undefined
        const runner = new NativeEvidenceModelRunner({
          runtime: this.options.runtime,
          provider: request.provider,
          workingDirectory: this.options.workingDirectory,
          config: request.config,
          onReduceEvent: (event) => {
            if (event.type === 'usage') this.options.onEvent?.({ chatId, event })
          },
          onReduceResult: (value) => { reduceResult = value },
        })
        const evidenceResult = await runLiveSessionEvidence({
          question: message,
          currentChat: {
            chatId,
            nativeSessionId,
            nativeHandle: nativeSessionHandle?.nativeHandle,
          },
        }, evidencePlan, runner, {
          homeDir: this.options.sessionEvidenceHomeDir,
          tempParentDir: this.options.sessionEvidenceTempParentDir,
          onProgress: (progress) => {
            if (progress.coverage) evidenceSummary = progress.coverage
            this.options.onEvent?.({
              chatId,
              event: { type: 'evidence_progress', progress },
            })
          },
        })
        if (!reduceResult) throw new Error('session evidence reduce result is unavailable')
        result = reduceResult
        assistantContent = evidenceResult.renderedAnswer
      } else {
        result = await this.sendNativeTurn({
          chatId,
          provider: request.provider,
          nativeSessionId,
          nativeSessionHandle,
          message,
          contextPrompt,
          contextRevision,
          pastedTextAttachments,
          config: request.config,
          onTimeline: (value) => { timeline = value },
        })
        assistantContent = result.content
      }
      const completedAt = this.now()
      if (contextPrompt) {
        this.options.store.markNativeSessionContextInjected(
          chatId, contextRevision, contextSelected, completedAt,
        )
      }
      this.options.store.bindNativeSession(
        chatId,
        result.nativeSessionHandle ?? result.nativeSessionId,
        completedAt,
      )
      if (result.contextUsage) {
        this.options.store.updateContextUsage(chatId, result.contextUsage, completedAt)
      }
      timeline = completeNativeTimeline(timeline, assistantContent)
      this.options.store.appendNativeMessage(chatId, visibleMessage({
        id: randomUUID(),
        role: 'assistant',
        content: assistantContent,
        at: completedAt,
        startedAt,
        timeline,
        toolActivities: timeline.flatMap((item) => item.type === 'tool' ? [item.activity] : []),
        evidenceSummary,
      }))
      this.options.onTurnCompleted?.(chatId)
      return { chatId, nativeSessionId: result.nativeSessionId }
    } catch (error) {
      this.options.store.markNativeTurnFailed(chatId, errorMessage(error), this.now())
      throw error
    } finally {
      this.options.onThreadChanged?.(chatId)
    }
  }

  private async sendNativeTurn(input: {
    chatId: string
    provider: NativeChatProvider
    nativeSessionId: string | null
    nativeSessionHandle: NativeSessionHandle | null
    message: string
    contextPrompt: string | null
    contextRevision: number
    pastedTextAttachments: NativePastedTextAttachment[]
    config: NativeTurnConfig
    onTimeline: (timeline: NativeTurnTimelineItem[]) => void
  }): Promise<NativeTurnResult> {
    const preparedInput = await prepareSessionContextInput({
      provider: input.provider,
      message: input.message,
      contextPrompt: input.contextPrompt,
      revision: input.contextRevision,
      pastedTextAttachments: input.pastedTextAttachments,
    })
    let timeline: NativeTurnTimelineItem[] = []
    try {
      return await this.options.runtime.sendTurn({
        chatId: input.chatId,
        provider: input.provider,
        nativeSessionId: input.nativeSessionId,
        nativeSessionHandle: input.nativeSessionHandle,
        message: preparedInput.message,
        ...(preparedInput.mentions ? { mentions: preparedInput.mentions } : {}),
        workingDirectory: this.options.workingDirectory,
        config: input.config,
        onEvent: (event) => {
          timeline = mergeNativeTimelineEvent(timeline, event)
          input.onTimeline(timeline)
          if (event.type === 'assistant_delta' || event.type === 'thinking_delta') {
            const item = timeline.find((current) =>
              current.itemId === event.itemId
              && current.type === (event.type === 'assistant_delta' ? 'assistant' : 'thinking'),
            )
            this.options.onEvent?.({
              chatId: input.chatId,
              event: {
                ...event,
                content: item?.type === 'assistant' || item?.type === 'thinking'
                  ? item.content
                  : event.text,
              },
            })
          } else {
            this.options.onEvent?.({ chatId: input.chatId, event })
          }
        },
      })
    } finally {
      input.onTimeline(timeline)
      await preparedInput.cleanup()
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
      ...(request.thinkingOptionId ? { thinkingOptionId: request.thinkingOptionId } : {}),
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
    let timeline: NativeTurnTimelineItem[] = []
    let firstProviderTurn = true
    let contextRevision = 0
    let contextSelected: NativeSessionReference[] = []
    try {
      await runRulesGenerate({
        ...generationEvidenceOptions(input.request),
        runId: input.runId,
        ...rulesGenerationCoreBridge(input.provider, input.config.model),
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
          const result = await (async () => {
            const preparedInput = await prepareSessionContextInput({
              provider: input.provider,
              message: prompt,
              contextPrompt,
              revision: contextRevision,
            })
            try {
              return await this.options.runtime.sendTurn({
                chatId: input.chatId,
                provider: input.provider,
                nativeSessionId,
                message: preparedInput.message,
                ...(preparedInput.mentions ? { mentions: preparedInput.mentions } : {}),
                workingDirectory: this.options.workingDirectory,
                config: input.config,
                outputSchema,
                onEvent: (event) => {
                  timeline = mergeNativeTimelineEvent(timeline, event)
                  if (event.type === 'tool_activity' || event.type === 'thinking_delta') {
                    this.options.onEvent?.({ chatId: input.chatId, event })
                  } else if (event.type === 'usage') {
                    this.options.onEvent?.({ chatId: input.chatId, event })
                  }
                },
              })
            } finally {
              await preparedInput.cleanup()
            }
          })()
          nativeSessionId = result.nativeSessionId
          this.options.store.bindNativeSession(
            input.chatId,
            result.nativeSessionHandle ?? result.nativeSessionId,
            this.now(),
          )
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
      const summary = rulesArtifactSummary(projectResponses, candidateCount)
      timeline = completeNativeTimeline(
        timeline.filter((item) => item.type !== 'assistant'),
        summary,
      )
      this.options.store.appendNativeMessage(input.chatId, visibleMessage({
        id: randomUUID(),
        role: 'assistant',
        content: summary,
        at: completedAt,
        timeline,
        toolActivities: timeline.flatMap((item) => item.type === 'tool' ? [item.activity] : []),
      }))
      this.options.store.completeNativeRulesRun(input.chatId, {
        runId: input.runId,
        projectCount: evidence?.projects.length ?? projectResponses.length,
        sessionCount: evidence?.totalSessions ?? 0,
        candidateCount,
        projectResponses,
      }, completedAt)
      updateRunMetadata(input.runId, 'completed', input.request, evidence, candidateCount)
      this.options.onTurnCompleted?.(input.chatId)
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

  pin(chatId: string): void {
    this.options.store.pinNativeThread(chatId, this.now())
  }

  unpin(chatId: string): void {
    this.options.store.unpinNativeThread(chatId)
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
    const located = locateToolActivity(thread.messages, request.itemId)
    if (!located) throw new Error('tool item was not found')
    return this.options.runtime.readToolItem({
      chatId: request.chatId,
      provider: thread.provider,
      nativeSessionId: thread.nativeSessionId,
      nativeSessionHandle: thread.nativeSessionHandle,
      itemId: request.itemId,
      sourceLocator: located.activity.sourceLocator ?? {
        turnIndex: located.turnIndex,
        toolIndex: located.toolIndex,
      },
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

export function rulesGenerationCoreBridge(
  provider: NativeChatProvider,
  model: string | undefined,
): { provider: 'claude' | 'codex'; model?: string } {
  if (provider === 'pi') throw new Error('Pi 不支持规则生成')
  if (provider === 'opencode') {
    return { provider: 'codex', model: model ?? 'opencode:default' }
  }
  return { provider, ...(model ? { model } : {}) }
}

function evidenceAgent(value: string): AgentName {
  if (
    value === 'claude'
    || value === 'codex'
    || value === 'copilot'
    || value === 'cursor'
    || value === 'opencode'
    || value === 'pi'
  ) return value
  throw new Error('session evidence agent is unsupported')
}

function locateToolActivity(messages: ChatMessage[], itemId: string): {
  activity: NativeToolActivity
  turnIndex: number
  toolIndex: number
} | null {
  let turnIndex = 0
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const activities = message.toolActivities ?? []
    const toolIndex = activities.findIndex((activity) => activity.itemId === itemId)
    if (toolIndex >= 0) {
      return { activity: activities[toolIndex], turnIndex, toolIndex }
    }
    turnIndex++
  }
  return null
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
  startedAt?: string
  turnConfig?: NativeTurnConfig
  attachments?: ChatMessage['attachments']
  toolActivities?: NativeToolActivity[]
  timeline?: NativeTurnTimelineItem[]
  evidenceSummary?: SessionEvidenceCoverageSummary
}): ChatMessage {
  return {
    id: input.id,
    role: input.role,
    kind: 'text',
    content: input.content,
    status: 'completed',
    createdAt: input.startedAt ?? input.at,
    completedAt: input.at,
    ...(input.turnConfig ? { turnConfig: { ...input.turnConfig } } : {}),
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(input.toolActivities && input.toolActivities.length > 0
      ? { toolActivities: input.toolActivities.map((activity) => ({ ...activity })) }
      : {}),
    ...(input.timeline && input.timeline.length > 0
      ? { timeline: input.timeline.map((item) => item.type === 'tool'
          ? { ...item, activity: { ...item.activity } }
          : { ...item }) }
      : {}),
    ...(input.evidenceSummary ? { sessionEvidence: { ...input.evidenceSummary } } : {}),
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
