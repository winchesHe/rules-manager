import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  ChatProviderAdapter,
  NativeTurnRequest,
  NativeTurnResult,
  NativeToolItemPage,
  NativeToolItemReadRequest,
  NativeToolSourceLocator,
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
  agentMessages: Map<string, string>
  reasoningMessages: Map<string, string>
  toolIndexes: Map<string, number>
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

  constructor(
    private readonly createProcess: CodexProcessFactory = defaultProcessFactory,
    private readonly codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
  ) {}

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
    let match: Record<string, unknown> | null = null
    try {
      const response = await client.request('thread/read', {
        threadId: request.nativeSessionId,
        includeTurns: true,
      })
      match = findItemById(response, request.itemId)
    } catch {
      // The local JSONL remains authoritative when app-server cannot reconstruct old tool items.
    }
    if (match) return pageContent(JSON.stringify(match, null, 2), request.cursor, request.limit)
    const sourceItem = request.sourceLocator
      ? readSourceToolItem(this.codexHome, request.nativeSessionId, request.sourceLocator)
      : null
    return sourceItem
      ? pageContent(JSON.stringify(sourceItem, null, 2), request.cursor, request.limit)
      : { available: false, content: '', nextCursor: null }
  }

  async archive(nativeSessionId: string): Promise<void> {
    const client = await this.ensureClient()
    await client.request('thread/archive', { threadId: nativeSessionId })
  }

  async unarchive(nativeSessionId: string): Promise<void> {
    const client = await this.ensureClient()
    await client.request('thread/unarchive', { threadId: nativeSessionId })
  }

  async delete(nativeSessionId: string): Promise<void> {
    const client = await this.ensureClient()
    try {
      await client.request('thread/delete', { threadId: nativeSessionId })
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
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
        agentMessages: new Map(),
        reasoningMessages: new Map(),
        toolIndexes: new Map(),
        resolve,
        reject,
        ...(request.onEvent ? { onEvent: request.onEvent } : {}),
      }
    })
    this.active = activeTurn
    try {
      const response = asRecord(await client.request('turn/start', {
        threadId,
        input: [
          { type: 'text', text: request.message, text_elements: [] },
          ...(request.mentions ?? []).map((mention) => ({
            type: 'mention',
            name: mention.name,
            path: mention.path,
          })),
        ],
        cwd: request.workingDirectory,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        ...(request.config.model ? { model: request.config.model } : {}),
        effort: request.config.effort,
        summary: 'auto',
        serviceTier: request.config.fastMode ? 'fast' : null,
        ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
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
        const itemId = asString(params.itemId) ?? `message-${active.agentMessages.size}`
        active.agentMessages.set(
          itemId,
          `${active.agentMessages.get(itemId) ?? ''}${params.delta}`,
        )
        active.onEvent?.({ type: 'assistant_delta', itemId, text: params.delta })
      }
      return
    }
    if (
      method === 'item/reasoning/summaryTextDelta'
      || method === 'item/reasoning/textDelta'
      || method === 'item/reasoning/delta'
    ) {
      if (typeof params.delta === 'string') {
        const itemId = asString(params.itemId) ?? `reasoning-${active.reasoningMessages.size}`
        active.reasoningMessages.set(
          itemId,
          `${active.reasoningMessages.get(itemId) ?? ''}${params.delta}`,
        )
        active.onEvent?.({ type: 'thinking_delta', itemId, text: params.delta })
      }
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = asRecord(params.item)
      const itemType = asString(item.type)
      if (itemType === 'userMessage' || itemType === 'agentMessage') return
      if (itemType === 'reasoning') {
        const itemId = asString(item.id) ?? `reasoning-${active.reasoningMessages.size}`
        const streamed = active.reasoningMessages.get(itemId) ?? ''
        const completedContent = reasoningText(item)
        const content = streamed || completedContent
        if (content) active.reasoningMessages.set(itemId, content)
        active.onEvent?.({
          type: 'thinking_delta',
          itemId,
          text: streamed ? '' : completedContent,
          ...(content ? { content } : {}),
          status: method === 'item/started' ? 'running' : 'completed',
        })
        return
      }
      const activity = safeToolActivity({
        itemId: item.id,
        name: itemType,
        providerType: itemType,
        status: method === 'item/started' ? 'running' : 'completed',
        item,
      })
      if (activity && activity.kind !== 'thinking') {
        const existingToolIndex = active.toolIndexes.get(activity.itemId)
        const toolIndex = existingToolIndex ?? active.toolIndexes.size
        if (existingToolIndex === undefined) active.toolIndexes.set(activity.itemId, toolIndex)
        active.onEvent?.({
          type: 'tool_activity',
          activity: {
            ...activity,
            ...(active.turnId ? { sourceLocator: { turnId: active.turnId, toolIndex } } : {}),
          },
        })
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
      const structuredOutput = [...active.agentMessages.values()]
        .reverse()
        .map(parseStructuredOutput)
        .find((value) => value !== undefined)
        ?? parseStructuredOutput(active.content)
      active.resolve({
        nativeSessionId: active.threadId,
        content: active.content,
        ...(active.contextUsage ? { contextUsage: active.contextUsage } : {}),
        ...(structuredOutput !== undefined
          ? { structuredOutput }
          : {}),
      })
      return
    }
    const detail = asString(asRecord(turn.error).message)
    active.reject(new Error(detail ?? `Codex turn ${status}`))
  }
}

function parseStructuredOutput(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
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

function reasoningText(item: Record<string, unknown>): string {
  const fragments = [item.summary, item.content]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .flatMap((value) => {
      if (typeof value === 'string') return [value]
      const record = asRecord(value)
      return [record.text, record.content].filter((text): text is string => typeof text === 'string')
    })
  return fragments.join('\n').trim()
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

function readSourceToolItem(
  codexHome: string,
  nativeSessionId: string,
  locator: NativeToolSourceLocator,
): { call: Record<string, unknown>; output: Record<string, unknown> } | null {
  const sourcePath = findCodexSessionFile(codexHome, nativeSessionId)
  if (!sourcePath) return null
  let records: Array<Record<string, unknown>>
  try {
    records = fs.readFileSync(sourcePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [asRecord(JSON.parse(line) as unknown)]
        } catch {
          return []
        }
      })
  } catch {
    return null
  }
  const payloads = records.map((record) => asRecord(record.payload))
  const turnId = locator.turnId ?? turnIdAt(records, locator.turnIndex)
  if (!turnId) return null
  const calls = payloads
    .filter((payload) => isToolCall(payload) && sourceTurnId(payload) === turnId)
  const call = calls[locator.toolIndex]
  if (!call) return null
  const callId = asString(call.call_id) ?? asString(call.callId)
  if (!callId) return null
  const output = payloads
    .find((payload) => isToolOutput(payload) && sourceCallId(payload) === callId)
  if (!output) return null
  return { call, output }
}

function findCodexSessionFile(codexHome: string, nativeSessionId: string): string | null {
  const date = uuidV7Date(nativeSessionId)
  if (date) {
    const dayDirectory = path.join(
      codexHome,
      'sessions',
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    )
    const direct = findSessionFile(dayDirectory, nativeSessionId, false)
    if (direct) return direct
  }
  return findSessionFile(path.join(codexHome, 'sessions'), nativeSessionId, true)
    ?? findSessionFile(path.join(codexHome, 'archived_sessions'), nativeSessionId, true)
}

function findSessionFile(
  directory: string,
  nativeSessionId: string,
  recursive: boolean,
): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isFile() && entry.name.endsWith(`${nativeSessionId}.jsonl`)) return entryPath
    if (recursive && entry.isDirectory()) {
      const nested = findSessionFile(entryPath, nativeSessionId, true)
      if (nested) return nested
    }
  }
  return null
}

function uuidV7Date(value: string): Date | null {
  const timestamp = Number.parseInt(value.replace(/-/g, '').slice(0, 12), 16)
  if (!Number.isFinite(timestamp)) return null
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

function turnIdAt(records: Array<Record<string, unknown>>, turnIndex: number | undefined): string | null {
  if (turnIndex === undefined || !Number.isInteger(turnIndex) || turnIndex < 0) return null
  const turnIds = records
    .filter((record) => record.type === 'turn_context')
    .map((record) => asString(asRecord(record.payload).turn_id))
    .filter((value): value is string => value !== null)
  return turnIds[turnIndex] ?? null
}

function isToolCall(payload: Record<string, unknown>): boolean {
  return payload.type === 'custom_tool_call' || payload.type === 'function_call'
}

function isToolOutput(payload: Record<string, unknown>): boolean {
  return payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output'
}

function sourceTurnId(payload: Record<string, unknown>): string | null {
  return asString(asRecord(payload.internal_chat_message_metadata_passthrough).turn_id)
}

function sourceCallId(payload: Record<string, unknown>): string | null {
  return asString(payload.call_id) ?? asString(payload.callId)
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

function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not found|does not exist|unknown thread/i.test(message)
}
