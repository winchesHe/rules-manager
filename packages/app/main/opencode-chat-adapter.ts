import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import type {
  ChatProviderAdapter,
  NativeInteractionResponse,
  NativeToolItemPage,
  NativeToolItemReadRequest,
  NativeTurnRequest,
  NativeTurnResult,
} from './chat-runtime.js'
import { safeToolActivity } from './chat-event.js'
import {
  sharedOpenCodeServerManager,
  type OpenCodeServerLease,
} from './opencode-server-manager.js'
import { HOST_SESSION_POLICY } from './claude-chat-adapter.js'

type OpenCodeClient = ReturnType<typeof createOpencodeClient>

export interface OpenCodeAdapterDependencies {
  acquireServer?: () => Promise<OpenCodeServerLease>
  createClient?: (input: { baseUrl: string; directory: string }) => OpenCodeClient
}

interface ActiveTurn {
  sessionId: string
  directory: string
  content: string
  toolPolicy: NonNullable<NativeTurnRequest['toolPolicy']>
  structuredOutput?: unknown
  contextUsage?: { usedTokens: number; maxTokens: number }
  onEvent?: NativeTurnRequest['onEvent']
  resolve: (result: NativeTurnResult) => void
  reject: (error: Error) => void
}

export class OpenCodeChatAdapter implements ChatProviderAdapter {
  private client: OpenCodeClient | null = null
  private lease: OpenCodeServerLease | null = null
  private active: ActiveTurn | null = null
  private streamAbort: AbortController | null = null
  private streamTask: Promise<void> | null = null
  private directory = ''
  private pendingQuestions = new Map<string, Array<{ id: string }>>()
  private runningToolDetails = new Map<string, string>()

  constructor(private readonly deps: OpenCodeAdapterDependencies = {}) {}

  start(request: NativeTurnRequest): Promise<NativeTurnResult> {
    return this.run(request, false)
  }

  resume(request: NativeTurnRequest & { nativeSessionId: string }): Promise<NativeTurnResult> {
    return this.run(request, true)
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.active) return
    await this.client.session.abort({
      sessionID: this.active.sessionId,
      directory: this.active.directory,
    })
  }

  async respondToInteraction(response: NativeInteractionResponse): Promise<void> {
    if (!this.client) throw new Error('OpenCode client 不可用')
    const questions = this.pendingQuestions.get(response.requestId)
    if (!questions) throw new Error('OpenCode question 已失效')
    if (response.cancelled) {
      await this.client.question.reject({ requestID: response.requestId, directory: this.directory })
    } else {
      await this.client.question.reply({
        requestID: response.requestId,
        directory: this.directory,
        answers: questions.map((question) => response.answers[question.id] ?? []),
      })
    }
    this.pendingQuestions.delete(response.requestId)
  }

  async readToolItem(request: NativeToolItemReadRequest): Promise<NativeToolItemPage> {
    const running = this.runningToolDetails.get(request.itemId)
    if (running) return pageContent(running, request.cursor, request.limit)
    const client = await this.ensureClient(this.directory || process.cwd())
    const response = await client.session.messages({
      sessionID: request.nativeSessionId,
      directory: this.directory || undefined,
    })
    const match = findById(response.data, request.itemId)
    return match
      ? pageContent(JSON.stringify(match, null, 2), request.cursor, request.limit)
      : { available: false, content: '', nextCursor: null }
  }

  async archive(nativeSessionId: string): Promise<void> {
    const client = await this.ensureClient(this.directory || process.cwd())
    await expectSuccess(client.session.update({
      sessionID: nativeSessionId,
      directory: this.directory || undefined,
      time: { archived: Date.now() },
    }), 'OpenCode session archive')
  }

  async unarchive(nativeSessionId: string): Promise<void> {
    const client = await this.ensureClient(this.directory || process.cwd())
    await expectSuccess(client.session.update({
      sessionID: nativeSessionId,
      directory: this.directory || undefined,
      time: { archived: 0 },
    }), 'OpenCode session unarchive')
  }

  async delete(nativeSessionId: string): Promise<void> {
    const client = await this.ensureClient(this.directory || process.cwd())
    await expectSuccess(client.session.delete({
      sessionID: nativeSessionId,
      directory: this.directory || undefined,
    }), 'OpenCode session delete')
  }

  async close(): Promise<void> {
    this.failActive(new Error('OpenCode adapter 已关闭'))
    this.streamAbort?.abort()
    await this.streamTask?.catch(() => undefined)
    this.streamAbort = null
    this.streamTask = null
    this.client = null
    await this.lease?.release()
    this.lease = null
  }

  private async run(request: NativeTurnRequest, resuming: boolean): Promise<NativeTurnResult> {
    if (this.active) throw new Error('OpenCode adapter already has an active turn')
    const client = await this.ensureClient(request.workingDirectory)
    const sessionId = resuming
      ? request.nativeSessionId
      : await this.createSession(client, request.workingDirectory, request.toolPolicy ?? 'full')
    if (!sessionId) throw new Error('OpenCode session id 不可用')
    await this.ensureEventStream(client)

    const completion = new Promise<NativeTurnResult>((resolve, reject) => {
      this.active = {
        sessionId,
        directory: request.workingDirectory,
        content: '',
        toolPolicy: request.toolPolicy ?? 'full',
        ...(request.onEvent ? { onEvent: request.onEvent } : {}),
        resolve,
        reject,
      }
    })
    const model = parseModel(request.config.model)
    const response = await client.session.promptAsync({
      sessionID: sessionId,
      directory: request.workingDirectory,
      parts: [{ type: 'text', text: request.message }],
      system: resuming ? undefined : HOST_SESSION_POLICY,
      ...(model ? { model } : {}),
      ...(request.config.thinkingOptionId ? { variant: request.config.thinkingOptionId } : {}),
      ...(request.outputSchema
        ? { format: { type: 'json_schema' as const, schema: request.outputSchema } }
        : {}),
    })
    if (response.error) {
      this.failActive(new Error(`OpenCode prompt 失败：${JSON.stringify(response.error)}`))
    }
    return completion
  }

  private async createSession(
    client: OpenCodeClient,
    directory: string,
    toolPolicy: NonNullable<NativeTurnRequest['toolPolicy']>,
  ): Promise<string> {
    const response = await client.session.create({
      directory,
      permission: [{
        permission: '*', pattern: '*', action: toolPolicy === 'none' ? 'deny' : 'allow',
      }],
    })
    if (response.error || !response.data?.id) {
      throw new Error(`OpenCode session.create 失败：${JSON.stringify(response.error)}`)
    }
    return response.data.id
  }

  private async ensureClient(directory: string): Promise<OpenCodeClient> {
    this.directory = directory
    if (this.client) return this.client
    this.lease = await (this.deps.acquireServer?.() ?? sharedOpenCodeServerManager.acquire())
    this.client = (this.deps.createClient ?? createOpencodeClient)({
      baseUrl: this.lease.url,
      directory,
    })
    return this.client
  }

  private async ensureEventStream(client: OpenCodeClient): Promise<void> {
    if (this.streamTask) return
    const abort = new AbortController()
    this.streamAbort = abort
    const response = await client.global.event({ signal: abort.signal, sseMaxRetryAttempts: 0 })
    this.streamTask = (async () => {
      try {
        for await (const raw of response.stream) this.handleEvent(raw)
        if (!abort.signal.aborted && this.active) {
          this.failActive(new Error('OpenCode SSE 在 turn 完成前断开'))
        }
      } catch (error) {
        if (!abort.signal.aborted) this.failActive(toError(error))
      }
    })()
  }

  private handleEvent(raw: unknown): void {
    const wrapper = asRecord(raw)
    const payload = asRecord(wrapper.payload)
    const event = typeof payload.type === 'string' ? payload : wrapper
    const dataRecord = asRecord(event.data)
    const data = Object.keys(dataRecord).length > 0 ? dataRecord : asRecord(event.properties)
    const active = this.active
    const sessionId = asString(data.sessionID)
      ?? asString(asRecord(data.info).sessionID)
      ?? asString(asRecord(data.part).sessionID)
    if (!active || (sessionId && sessionId !== active.sessionId)) return

    if (event.type === 'permission.asked') {
      const requestId = asString(data.id)
      if (requestId && this.client) {
        void this.client.permission.reply({
          requestID: requestId,
          directory: active.directory,
          reply: active.toolPolicy === 'none' ? 'reject' : 'always',
        }).catch((error) => this.failActive(toError(error)))
      }
      return
    }
    if (event.type === 'question.asked') {
      const requestId = asString(data.id)
      const questions = Array.isArray(data.questions) ? data.questions.map(asRecord) : []
      if (requestId) {
        const normalized = questions.map((question, index) => ({
          id: asString(question.header) ?? `question-${index}`,
          label: asString(question.question) ?? asString(question.header) ?? `Question ${index + 1}`,
          options: Array.isArray(question.options)
            ? question.options.map(asRecord).map((option) => asString(option.label)).filter(isString)
            : [],
          multiple: question.multiple === true,
        }))
        this.pendingQuestions.set(requestId, normalized)
        active.onEvent?.({
          type: 'interaction_request',
          request: { requestId, kind: 'question', questions: normalized },
        })
      }
      return
    }
    if (event.type === 'message.part.delta' && typeof data.delta === 'string') {
      const itemId = asString(data.partID) ?? 'opencode-part'
      if (data.field === 'reasoning') {
        active.onEvent?.({ type: 'thinking_delta', itemId, text: data.delta })
      } else if (data.field === 'text') {
        active.content += data.delta
        active.onEvent?.({ type: 'assistant_delta', itemId, text: data.delta })
      }
      return
    }
    if (event.type === 'message.part.updated') {
      const part = asRecord(data.part)
      const itemId = asString(part.id) ?? asString(part.callID) ?? 'opencode-part'
      if (part.type === 'tool') {
        this.runningToolDetails.set(itemId, JSON.stringify(part, null, 2))
        const state = asRecord(part.state)
        const activity = safeToolActivity({
          itemId,
          name: part.tool,
          status: state.status === 'error' ? 'failed'
            : state.status === 'completed' ? 'completed' : 'running',
          input: state.input,
        })
        if (activity) active.onEvent?.({ type: 'tool_activity', activity })
      }
      return
    }
    if (event.type === 'message.updated') {
      const info = asRecord(data.info)
      if (info.role === 'assistant') {
        if (info.structured !== undefined) active.structuredOutput = info.structured
        const tokens = asRecord(info.tokens)
        const total = numeric(tokens.total)
        const usedTokens = total > 0
          ? total
          : numeric(tokens.input) + numeric(tokens.output) + numeric(tokens.reasoning)
        if (usedTokens > 0) active.contextUsage = { usedTokens, maxTokens: 0 }
      }
      return
    }
    if (event.type === 'session.error') {
      this.failActive(new Error(`OpenCode turn 失败：${JSON.stringify(data.error ?? {})}`))
      return
    }
    if (event.type === 'session.idle') {
      this.active = null
      active.resolve({
        nativeSessionId: active.sessionId,
        nativeSessionHandle: { sessionId: active.sessionId, nativeHandle: active.sessionId },
        content: active.content,
        ...(active.structuredOutput !== undefined ? { structuredOutput: active.structuredOutput } : {}),
        ...(active.contextUsage?.maxTokens
          ? { contextUsage: active.contextUsage }
          : {}),
      })
    }
  }

  private failActive(error: Error): void {
    const active = this.active
    if (!active) return
    this.active = null
    active.reject(error)
  }
}

async function expectSuccess(
  promise: Promise<{ error?: unknown }>,
  label: string,
): Promise<void> {
  const response = await promise
  if (response.error) throw new Error(`${label} 失败：${JSON.stringify(response.error)}`)
}

function parseModel(value?: string): { providerID: string; modelID: string } | undefined {
  if (!value) return undefined
  const separator = value.indexOf('/')
  return separator > 0
    ? { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
    : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function findById(value: unknown, id: string): unknown | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findById(item, id)
      if (match) return match
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.id === id || record.callID === id) return record
  for (const child of Object.values(record)) {
    const match = findById(child, id)
    if (match) return match
  }
  return null
}

function pageContent(content: string, cursor: number, limit: number): NativeToolItemPage {
  const start = Math.max(0, cursor)
  const end = Math.min(content.length, start + Math.max(1, Math.min(limit, 64 * 1024)))
  return { available: true, content: content.slice(start, end), nextCursor: end < content.length ? end : null }
}
