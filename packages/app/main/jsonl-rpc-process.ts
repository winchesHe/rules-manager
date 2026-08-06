import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  type: string
}

export interface JsonlRpcChild {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

export interface JsonlRpcProcessOptions {
  name: string
  command: string
  args: string[]
  cwd: string
  spawnProcess?: (command: string, args: string[], cwd: string) => JsonlRpcChild
  requestTimeoutMs?: number
  gracefulTimeoutMs?: number
  forceTimeoutMs?: number
}

const STDERR_LIMIT = 8_192

export class JsonlRpcProcess {
  private readonly child: JsonlRpcChild
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(message: Record<string, unknown>) => void>()
  private readonly exitListeners = new Set<(error: Error) => void>()
  private readonly requestTimeoutMs: number
  private readonly gracefulTimeoutMs: number
  private readonly forceTimeoutMs: number
  private readonly ownsProcessGroup: boolean
  private buffer = ''
  private nextId = 1
  private exited = false
  private closing = false
  stderrTail = ''

  constructor(private readonly options: JsonlRpcProcessOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? 2_000
    this.forceTimeoutMs = options.forceTimeoutMs ?? 1_000
    this.ownsProcessGroup = !options.spawnProcess && process.platform !== 'win32'
    this.child = (options.spawnProcess ?? defaultSpawn)(options.command, options.args, options.cwd)
    this.child.stdout.setEncoding?.('utf8')
    this.child.stderr.setEncoding?.('utf8')
    this.child.stdout.on('data', (chunk) => this.consume(String(chunk)))
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-STDERR_LIMIT)
    })
    this.child.on('error', (error) => this.handleExit(this.exitError(error.message)))
    this.child.on('exit', (code, signal) => {
      this.exited = true
      this.handleExit(this.exitError(String(code ?? signal ?? 'unknown')))
    })
  }

  onMessage(listener: (message: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  request(command: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.exited || this.closing) return Promise.reject(new Error(`${this.options.name} process 不可用`))
    const id = `mm-${this.nextId++}`
    const type = typeof command.type === 'string' ? command.type : 'request'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.options.name} ${type} 超时${this.stderrSuffix()}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, type })
      this.send({ ...command, id })
    })
  }

  send(frame: Record<string, unknown>): void {
    if (this.exited || this.closing) throw new Error(`${this.options.name} process 不可用`)
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.failAll(new Error(`${this.options.name} process 已关闭`))
    this.child.stdin.end?.()
    if (this.exited) return
    this.signal('SIGTERM')
    if (await this.waitForExit(this.gracefulTimeoutMs)) return
    this.signal('SIGKILL')
    await this.waitForExit(this.forceTimeoutMs)
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
        const parsed = JSON.parse(line)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        message = parsed as Record<string, unknown>
      } catch {
        continue
      }
      if (message.type === 'response' && typeof message.id === 'string') {
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.success === false) {
          pending.reject(new Error(`${this.options.name} ${pending.type} 失败: ${String(message.error ?? 'unknown')}`))
        } else {
          pending.resolve(message.data)
        }
        continue
      }
      for (const listener of this.listeners) listener(message)
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  private handleExit(error: Error): void {
    this.failAll(error)
    for (const listener of this.exitListeners) listener(error)
  }

  private exitError(reason: string): Error {
    return new Error(`${this.options.name} exited (${reason})${this.stderrSuffix()}`)
  }

  private stderrSuffix(): string {
    return this.stderrTail ? `: ${this.stderrTail}` : ''
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.ownsProcessGroup && this.child.pid) {
      try {
        process.kill(-this.child.pid, signal)
        return
      } catch {
        // 进程组可能已退出，回退到直接终止子进程。
      }
    }
    try { this.child.kill(signal) } catch { /* 已退出 */ }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(this.exited), timeoutMs)
      this.child.on('exit', () => finish(true))
    })
  }
}

function defaultSpawn(command: string, args: string[], cwd: string): JsonlRpcChild {
  return spawn(command, args, {
    cwd,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
  }) as ChildProcessWithoutNullStreams
}
