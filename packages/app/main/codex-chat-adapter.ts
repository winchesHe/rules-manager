import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  ChatProviderAdapter,
  NativeTurnRequest,
  NativeTurnResult,
  NativeToolItemPage,
  NativeToolItemReadRequest,
} from './chat-runtime.js'
import { HOST_SESSION_POLICY } from './claude-chat-adapter.js'
import { safeToolActivity } from './chat-event.js'

export interface CodexAppServerProcess {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export type CodexProcessFactory = () => CodexAppServerProcess

const defaultProcessFactory: CodexProcessFactory = () => spawn(
  'codex',
  ['app-server', '--stdio'],
  { stdio: 'pipe' },
) as ChildProcessWithoutNullStreams

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface ActiveCodexTurn {
  threadId: string
  turnId: string | null
  content: string
  contextUsage?: { usedTokens: number; maxTokens: number }
  resolve: (value: NativeTurnResult) => void
  reject: (error: Error) => void
  onEvent?: NativeTurnRequest['onEvent']
}

class CodexRpcClient {
  private nextId = 1
  private buffer = ''
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>()
  private stderr = ''

  constructor(readonly process: CodexAppServerProcess) {
    process.stdout.on('data', (chunk) => this.consume(chunk.toString()))
    process.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4_000)
    })
    process.on('exit', (code, signal) => {
      const detail = this.stderr.trim()
      const error = new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`)
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    })
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params })
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  private write(message: unknown): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end < 0) return
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(rpcError(message.error)))
        else pending.resolve(message.result)
        continue
      }
      if (typeof message.method === 'string') {
        for (const listener of this.notificationListeners) {
          listener(message.method, message.params)
        }
      }
    }
  }
}

export class CodexChatAdapter implements ChatProviderAdapter {
  private client: CodexRpcClient | null = null
  private initialized = false
  private currentThreadId: string | null = null
  private active: ActiveCodexTurn | null = null
  private unsubscribe: (() => void) | null = null

  constructor(private readonly createProcess: CodexProcessFactory = defaultProcessFactory) {}

  start(request: NativeTurnRequest): Promise<NativeTurnResult> {
    return this.run(request, false)
  }

  resume(request: NativeTurnRequest & { nativeSessionId: string }): Promise<NativeTurnResult> {
    return this.run(request, true)
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.active?.turnId) return
    await this.client.request('turn/interrupt', {
      threadId: this.active.threadId,
      turnId: this.active.turnId,
    })
  }

  async close(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.client?.process.kill('SIGTERM')
    this.client = null
    this.initialized = false
  }

  async readToolItem(request: NativeToolItemReadRequest): Promise<NativeToolItemPage> {
    const client = await this.ensureClient()
    const response = await client.request('thread/read', {
      threadId: request.nativeSessionId,
      includeTurns: true,
    })
    const match = findItemById(response, request.itemId)
    if (!match) return { available: false, content: '', nextCursor: null }
    return pageContent(JSON.stringify(match, null, 2), request.cursor, request.limit)
  }

  private async run(request: NativeTurnRequest, resuming: boolean): Promise<NativeTurnResult> {
    if (this.active) throw new Error('Codex adapter already has an active turn')
    const client = await this.ensureClient()
    if (resuming) {
      const threadId = request.nativeSessionId
      if (!threadId) throw new Error('Codex thread id is required for resume')
      if (this.currentThreadId !== threadId) {
        await client.request('thread/resume', { threadId })
        this.currentThreadId = threadId
      }
    } else {
      const response = asRecord(await client.request('thread/start', {
        ...(request.config.model ? { model: request.config.model } : {}),
        cwd: request.workingDirectory,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        developerInstructions: HOST_SESSION_POLICY,
      }))
      const threadId = asString(asRecord(response.thread).id)
      if (!threadId) throw new Error('Codex app-server did not return a thread id')
      this.currentThreadId = threadId
    }
    const threadId = this.currentThreadId
    if (!threadId) throw new Error('Codex thread is unavailable')

    let activeTurn!: ActiveCodexTurn
    const completion = new Promise<NativeTurnResult>((resolve, reject) => {
      activeTurn = {
        threadId,
        turnId: null,
        content: '',
        resolve,
        reject,
        ...(request.onEvent ? { onEvent: request.onEvent } : {}),
      }
    })
    this.active = activeTurn
    try {
      const response = asRecord(await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: request.message }],
        cwd: request.workingDirectory,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        ...(request.config.model ? { model: request.config.model } : {}),
        effort: request.config.effort,
        serviceTier: request.config.fastMode ? 'fast' : null,
      }))
      const turnId = asString(asRecord(response.turn).id)
      if (turnId && this.active === activeTurn) activeTurn.turnId = turnId
      return await completion
    } catch (error) {
      this.active = null
      throw error
    }
  }

  private async ensureClient(): Promise<CodexRpcClient> {
    if (!this.client) {
      this.client = new CodexRpcClient(this.createProcess())
      this.unsubscribe = this.client.onNotification((method, params) => {
        this.handleNotification(method, params)
      })
    }
    if (!this.initialized) {
      await this.client.request('initialize', {
        clientInfo: { name: 'memory-manager', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
      this.client.notify('initialized', {})
      this.initialized = true
    }
    return this.client
  }

  private handleNotification(method: string, value: unknown): void {
    const active = this.active
    if (!active) return
    const params = asRecord(value)
    const notificationThreadId = asString(params.threadId)
    if (notificationThreadId && notificationThreadId !== active.threadId) return
    if (method === 'turn/started') {
      active.turnId = asString(asRecord(params.turn).id) ?? active.turnId
      return
    }
    if (method === 'item/agentMessage/delta') {
      if (typeof params.delta === 'string') {
        active.content += params.delta
        active.onEvent?.({ type: 'assistant_delta', text: params.delta })
      }
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = asRecord(params.item)
      const activity = safeToolActivity({
        itemId: item.id,
        name: item.type,
        providerType: item.type,
        status: method === 'item/started' ? 'running' : 'completed',
        item,
      })
      if (activity && activity.kind !== 'thinking') {
        active.onEvent?.({ type: 'tool_activity', activity })
      }
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      active.contextUsage = normalizeContextUsage(params.tokenUsage) ?? active.contextUsage
      if (active.contextUsage) {
        active.onEvent?.({ type: 'usage', contextUsage: active.contextUsage })
      }
      return
    }
    if (method !== 'turn/completed') return
    const turn = asRecord(params.turn)
    const status = asString(turn.status) ?? 'failed'
    this.active = null
    if (status === 'completed' || status === 'interrupted') {
      active.resolve({
        nativeSessionId: active.threadId,
        content: active.content,
        ...(active.contextUsage ? { contextUsage: active.contextUsage } : {}),
      })
      return
    }
    const detail = asString(asRecord(turn.error).message)
    active.reject(new Error(detail ?? `Codex turn ${status}`))
  }
}

function normalizeContextUsage(value: unknown): { usedTokens: number; maxTokens: number } | null {
  const usage = asRecord(value)
  const last = asRecord(usage.last)
  const usedTokens = asNumber(last.total_tokens) ?? asNumber(last.totalTokens)
  const maxTokens = asNumber(usage.model_context_window) ?? asNumber(usage.modelContextWindow)
  return usedTokens !== null && maxTokens !== null ? { usedTokens, maxTokens } : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function rpcError(value: unknown): string {
  const error = asRecord(value)
  return asString(error.message) ?? 'Codex app-server request failed'
}

function findItemById(value: unknown, itemId: string): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findItemById(item, itemId)
      if (match) return match
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.id === itemId) return record
  for (const child of Object.values(record)) {
    const match = findItemById(child, itemId)
    if (match) return match
  }
  return null
}

function pageContent(content: string, cursor: number, limit: number): NativeToolItemPage {
  const start = Math.max(0, cursor)
  const size = Math.max(1, Math.min(limit, 64 * 1024))
  const end = Math.min(content.length, start + size)
  return {
    available: true,
    content: content.slice(start, end),
    nextCursor: end < content.length ? end : null,
  }
}
