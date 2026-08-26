import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export interface OpenCodeServerLease {
  url: string
  release(): Promise<void>
}

export interface OpenCodeServerProcess {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  pid?: number
  exitCode: number | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number | null) => void): this
}

interface ServerGeneration {
  process: OpenCodeServerProcess
  url: string
  refs: number
  ownsProcessGroup: boolean
}

export interface OpenCodeServerManagerOptions {
  allocatePort?: () => Promise<number>
  resolveCwd?: () => string
  spawnProcess?: (port: number, cwd: string) => OpenCodeServerProcess
  startupTimeoutMs?: number
  gracefulTimeoutMs?: number
  forceTimeoutMs?: number
}

export class OpenCodeServerManager {
  private server: ServerGeneration | null = null
  private starting: Promise<ServerGeneration> | null = null

  constructor(private readonly options: OpenCodeServerManagerOptions = {}) {}

  async acquire(): Promise<OpenCodeServerLease> {
    const server = this.starting
      ? await this.starting
      : this.server ?? await this.start()
    server.refs += 1
    let released = false
    return {
      url: server.url,
      release: async () => {
        if (released) return
        released = true
        server.refs = Math.max(0, server.refs - 1)
      },
    }
  }

  async shutdown(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server || server.process.exitCode !== null) return
    await terminateServer(
      server,
      this.options.gracefulTimeoutMs ?? 2_000,
      this.options.forceTimeoutMs ?? 1_000,
    )
  }

  private async start(): Promise<ServerGeneration> {
    if (this.starting) return this.starting
    this.starting = this.spawnServer().finally(() => { this.starting = null })
    return this.starting
  }

  private async spawnServer(): Promise<ServerGeneration> {
    const port = await (this.options.allocatePort ?? availablePort)()
    const cwd = this.options.resolveCwd?.()
      ?? path.join(os.homedir(), '.local', 'share', 'opencode')
    fs.mkdirSync(cwd, { recursive: true })
    const customSpawn = this.options.spawnProcess
    const child = customSpawn
      ? customSpawn(port, cwd)
      : spawn('opencode', ['serve', '--port', String(port)], {
          cwd, stdio: 'pipe', detached: process.platform !== 'win32',
        }) as ChildProcessWithoutNullStreams
    const server: ServerGeneration = {
      process: child,
      url: `http://127.0.0.1:${port}`,
      refs: 0,
      ownsProcessGroup: !customSpawn && process.platform !== 'win32',
    }
    this.server = server
    try {
      await waitUntilListening(child, this.options.startupTimeoutMs ?? 30_000)
      return server
    } catch (error) {
      if (this.server === server) this.server = null
      await terminateServer(
        server,
        this.options.gracefulTimeoutMs ?? 2_000,
        this.options.forceTimeoutMs ?? 1_000,
      )
      throw error
    }
  }
}

export const sharedOpenCodeServerManager = new OpenCodeServerManager()

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('无法分配 OpenCode 端口')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function waitUntilListening(child: OpenCodeServerProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const consume = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-8_192)
      if (output.toLowerCase().includes('listening on')) finish()
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => finish(new Error(
      `OpenCode server 提前退出（${code ?? 'unknown'}）：${output.trim()}`,
    )))
    const timer = setTimeout(() => finish(new Error(
      `OpenCode server 启动超时：${output.trim()}`,
    )), timeoutMs)
  })
}

async function terminateServer(
  server: ServerGeneration,
  gracefulTimeoutMs: number,
  forceTimeoutMs: number,
): Promise<void> {
  signalServer(server, 'SIGTERM')
  await waitForExit(server.process, gracefulTimeoutMs)
  if (server.process.exitCode !== null) return
  signalServer(server, 'SIGKILL')
  await waitForExit(server.process, forceTimeoutMs)
}

function signalServer(server: ServerGeneration, signal: NodeJS.Signals): void {
  if (server.ownsProcessGroup && server.process.pid) {
    try {
      process.kill(-server.process.pid, signal)
      return
    } catch {
      // 进程组已退出时回退到直接终止子进程。
    }
  }
  try { server.process.kill(signal) } catch { /* 已退出 */ }
}

function waitForExit(child: OpenCodeServerProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
