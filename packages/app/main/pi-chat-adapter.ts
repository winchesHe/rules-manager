import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  ChatProviderAdapter,
  NativeInteractionResponse,
  NativeToolItemPage,
  NativeToolItemReadRequest,
  NativeTurnRequest,
  NativeTurnResult,
} from './chat-runtime.js'
import { safeToolActivity } from './chat-event.js'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PiProcess {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export type PiProcessFactory = (
  args: string[],
  cwd: string,
) => PiProcess

const defaultProcessFactory: PiProcessFactory = (args, cwd) => spawn(
  'pi', args, { cwd, stdio: 'pipe' },
) as ChildProcessWithoutNullStreams

interface ActiveTurn {
  content: string
  onEvent?: NativeTurnRequest['onEvent']
  resolve: (result: NativeTurnResult) => void
  reject: (error: Error) => void
}

export class PiChatAdapter implements ChatProviderAdapter {
  private process: PiProcess | null = null
  private buffer = ''
  private stderr = ''
  private nextId = 1
  private pending = new Map<string, PendingRequest>()
  private active: ActiveTurn | null = null
  private sessionId = ''
  private sessionFile = ''
  private cwd = ''
  private pendingUi = new Map<string, string>()
  private interruptRequested = false

  constructor(private readonly createProcess: PiProcessFactory = defaultProcessFactory) {}

  start(request: NativeTurnRequest): Promise<NativeTurnResult> {
    return this.run(request, false)
  }

  resume(request: NativeTurnRequest & { nativeSessionId: string }): Promise<NativeTurnResult> {
    return this.run(request, true)
  }

  async interrupt(): Promise<void> {
    if (!this.process) return
    this.interruptRequested = true
    this.failActive(new Error('Pi turn interrupted'))
    await this.request({ type: 'abort' }, 1_000).catch(() => undefined)
    const process = this.process
    this.process = null
    process?.kill('SIGTERM')
  }

  async respondToInteraction(response: NativeInteractionResponse): Promise<void> {
    const method = this.pendingUi.get(response.requestId)
    if (!this.process || !method) {
      throw new Error('Pi 交互请求已失效')
    }
    const values = Object.values(response.answers).flat()
    const answer = values[0] ?? ''
    this.send(extensionUiResponse(response, method, answer, values))
    this.pendingUi.delete(response.requestId)
  }

  async readToolItem(request: NativeToolItemReadRequest): Promise<NativeToolItemPage> {
    await this.ensureProcess(
      this.cwd || process.cwd(),
      request.nativeSessionHandle?.nativeHandle || this.sessionFile || undefined,
    )
    const response = asRecord(await this.request({ type: 'get_messages' }))
    const match = findById(response.messages, request.itemId)
    return match
      ? pageContent(JSON.stringify(match, null, 2), request.cursor, request.limit)
      : { available: false, content: '', nextCursor: null }
  }

  async archive(_nativeSessionId: string): Promise<void> {}
  async unarchive(_nativeSessionId: string): Promise<void> {}
  async delete(_nativeSessionId: string): Promise<void> {}

  async close(): Promise<void> {
    const process = this.process
    this.process = null
    if (!process) return
    process.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        process.kill('SIGKILL')
        resolve()
      }, 5_000)
      process.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private async run(request: NativeTurnRequest, resuming: boolean): Promise<NativeTurnResult> {
    if (this.active) throw new Error('Pi adapter already has an active turn')
    this.interruptRequested = false
    const sessionFile = resuming
      ? request.nativeSessionHandle?.nativeHandle
      : undefined
    if (resuming && !sessionFile) {
      throw new Error('Pi resume 需要 native session file')
    }
    await this.ensureProcess(request.workingDirectory, sessionFile)
    if (this.interruptRequested) throw new Error('Pi turn interrupted')
    if (request.config.model) {
      const model = parseModel(request.config.model)
      if (model) await this.request({ type: 'set_model', provider: model.provider, modelId: model.id })
    }
    if (this.interruptRequested) throw new Error('Pi turn interrupted')
    if (request.config.thinkingOptionId) {
      await this.request({ type: 'set_thinking_level', level: request.config.thinkingOptionId })
    }
    if (this.interruptRequested) throw new Error('Pi turn interrupted')
    const completion = new Promise<NativeTurnResult>((resolve, reject) => {
      this.active = {
        content: '',
        ...(request.onEvent ? { onEvent: request.onEvent } : {}),
        resolve,
        reject,
      }
    })
    await this.request({ type: 'prompt', message: request.message })
    return completion
  }

  private async ensureProcess(cwd: string, sessionFile?: string): Promise<void> {
    if (this.process) return
    this.cwd = cwd
    const args = ['--mode', 'rpc', ...(sessionFile ? ['--session', sessionFile] : [])]
    const process = this.createProcess(args, cwd)
    this.process = process
    process.stdout.setEncoding?.('utf8')
    process.stderr.setEncoding?.('utf8')
    process.stdout.on('data', (chunk) => this.consume(chunk.toString()))
    process.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8_000)
    })
    process.on('exit', (code, signal) => {
      const error = new Error(
        `Pi RPC exited (${code ?? signal ?? 'unknown'})${this.stderr ? `: ${this.stderr}` : ''}`,
      )
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.pending.clear()
      this.failActive(error)
      this.process = null
    })
    const state = asRecord(await this.request({ type: 'get_state' }))
    this.captureState(state)
  }

  private request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const id = `mm-${this.nextId++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi RPC ${String(command.type)} 超时`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ ...command, id })
    })
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.process) throw new Error('Pi RPC process 不可用')
    this.process.stdin.write(`${JSON.stringify(frame)}\n`)
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
      if (message.type === 'response' && typeof message.id === 'string') {
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.success === false) pending.reject(new Error(String(message.error ?? 'Pi RPC 失败')))
        else pending.resolve(message.data)
        continue
      }
      this.handleEvent(message)
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    const active = this.active
    if (event.type === 'extension_ui_request') {
      const id = asString(event.id)
      const method = asString(event.method)
      if (id && active && isInteractiveUiMethod(method)) {
        this.pendingUi.set(id, method)
        const options = Array.isArray(event.options)
          ? event.options.map((option) => typeof option === 'string' ? option : asString(asRecord(option).label)).filter(isString)
          : undefined
        const confirmOptions = method === 'confirm' ? ['Yes', 'No'] : undefined
        active.onEvent?.({
          type: 'interaction_request',
          request: {
            requestId: id,
            kind: 'question',
            title: asString(event.title),
            questions: [{
              id: 'value',
              label: [asString(event.title), asString(event.message)].filter(isString).join('\n\n')
                || asString(event.prompt) || 'Pi 需要你的输入',
              ...((confirmOptions ?? options)?.length ? { options: confirmOptions ?? options } : {}),
              ...(typeof event.placeholder === 'string' ? { placeholder: event.placeholder } : {}),
            }],
          },
        })
      }
      return
    }
    if (!active) return
    if (event.type === 'message_update') {
      const update = asRecord(event.assistantMessageEvent)
      if (update.type === 'text_delta' && typeof update.delta === 'string') {
        active.content += update.delta
        active.onEvent?.({ type: 'assistant_delta', itemId: 'pi-assistant', text: update.delta })
      } else if (update.type === 'thinking_delta' && typeof update.delta === 'string') {
        active.onEvent?.({ type: 'thinking_delta', itemId: 'pi-thinking', text: update.delta })
      }
      return
    }
    if (event.type === 'tool_execution_start'
      || event.type === 'tool_execution_update'
      || event.type === 'tool_execution_end') {
      const itemId = asString(event.toolCallId) ?? 'pi-tool'
      const activity = safeToolActivity({
        itemId,
        name: event.toolName,
        status: event.type === 'tool_execution_end'
          ? event.isError === true ? 'failed' : 'completed'
          : 'running',
        input: event.args,
      })
      if (activity) active.onEvent?.({ type: 'tool_activity', activity })
      return
    }
    if (event.type === 'agent_end') void this.finishActive()
  }

  private async finishActive(): Promise<void> {
    const active = this.active
    if (!active) return
    try {
      const state = asRecord(await this.request({ type: 'get_state' }))
      this.captureState(state)
      const stats = await this.request({ type: 'get_session_stats' }).catch(() => null)
      const usage = contextUsage(stats ?? state)
      this.active = null
      active.resolve({
        nativeSessionId: this.sessionId,
        nativeSessionHandle: { sessionId: this.sessionId, nativeHandle: this.sessionFile },
        content: active.content,
        ...(usage ? { contextUsage: usage } : {}),
      })
    } catch (error) {
      this.failActive(toError(error))
    }
  }

  private captureState(state: Record<string, unknown>): void {
    this.sessionId = asString(state.sessionId) ?? this.sessionId
    this.sessionFile = asString(state.sessionFile) ?? this.sessionFile
  }

  private failActive(error: Error): void {
    const active = this.active
    if (!active) return
    this.active = null
    active.reject(error)
  }
}

function extensionUiResponse(
  response: NativeInteractionResponse,
  method: string,
  answer: string,
  values: string[],
): Record<string, unknown> {
  const base = { type: 'extension_ui_response', id: response.requestId }
  if (response.cancelled) return { ...base, cancelled: true }
  if (method === 'confirm') return { ...base, confirmed: /^yes$/i.test(answer) }
  return { ...base, value: values.length > 1 ? values.join(',') : answer }
}

function isInteractiveUiMethod(
  method: string | undefined,
): method is 'select' | 'confirm' | 'input' | 'editor' {
  return method === 'select' || method === 'confirm' || method === 'input' || method === 'editor'
}

function parseModel(value: string): { provider: string; id: string } | null {
  const separator = value.indexOf('/')
  return separator > 0
    ? { provider: value.slice(0, separator), id: value.slice(separator + 1) }
    : null
}

function contextUsage(value: unknown): { usedTokens: number; maxTokens: number } | undefined {
  const record = asRecord(value)
  const context = asRecord(record.contextUsage)
  const usedTokens = numeric(context.tokens)
  const maxTokens = numeric(context.contextWindow)
  return maxTokens > 0 ? { usedTokens, maxTokens } : undefined
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
  if (record.id === id || record.toolCallId === id || record.toolCallID === id) return record
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
