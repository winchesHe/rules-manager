import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export interface OpenCodeServerLease {
  url: string
  release(): Promise<void>
}

interface ServerGeneration {
  process: ChildProcessWithoutNullStreams
  url: string
  refs: number
}

export class OpenCodeServerManager {
  private server: ServerGeneration | null = null
  private starting: Promise<ServerGeneration> | null = null

  async acquire(): Promise<OpenCodeServerLease> {
    const server = this.server ?? await this.start()
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
    server.process.kill('SIGTERM')
    await waitForExit(server.process, 5_000)
    if (server.process.exitCode === null) {
      server.process.kill('SIGKILL')
      await waitForExit(server.process, 1_000)
    }
  }

  private async start(): Promise<ServerGeneration> {
    if (this.starting) return this.starting
    this.starting = this.spawnServer().finally(() => { this.starting = null })
    const server = await this.starting
    this.server = server
    return server
  }

  private async spawnServer(): Promise<ServerGeneration> {
    const port = await availablePort()
    const cwd = path.join(os.homedir(), '.local', 'share', 'opencode')
    fs.mkdirSync(cwd, { recursive: true })
    const child = spawn('opencode', ['serve', '--port', String(port)], {
      cwd,
      stdio: 'pipe',
    })
    const url = `http://127.0.0.1:${port}`
    await waitUntilListening(child, 30_000)
    return { process: child, url, refs: 0 }
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

function waitUntilListening(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
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
    const consume = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-8_192)
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

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
