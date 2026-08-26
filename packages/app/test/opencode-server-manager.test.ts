import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from '@jest/globals'
import {
  OpenCodeServerManager,
  type OpenCodeServerProcess,
} from '../main/opencode-server-manager.js'

describe('OpenCodeServerManager', () => {
  it('并发租约共享同一随机端口服务，release 幂等，shutdown 清理进程', async () => {
    const child = new FakeServerProcess()
    const manager = managerWith(child)
    const firstPromise = manager.acquire()
    await new Promise((resolve) => setImmediate(resolve))
    let secondSettled = false
    const secondPromise = manager.acquire().then((lease) => {
      secondSettled = true
      return lease
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(secondSettled).toBe(false)
    child.stdout.write('Listening on http://127.0.0.1:43210\n')
    const [first, second] = await Promise.all([firstPromise, secondPromise])

    expect(first.url).toBe('http://127.0.0.1:43210')
    expect(second.url).toBe(first.url)
    await first.release()
    await first.release()
    await second.release()
    await manager.shutdown()
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('启动失败也会清理已拥有的进程，未退出时升级 SIGKILL', async () => {
    const child = new FakeServerProcess()
    child.exitOnKill = 'SIGKILL'
    const manager = managerWith(child)
    const lease = manager.acquire()
    await new Promise((resolve) => setImmediate(resolve))
    child.stderr.write('boom')

    await expect(lease).rejects.toThrow('启动超时：boom')
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

function managerWith(child: FakeServerProcess): OpenCodeServerManager {
  return new OpenCodeServerManager({
    allocatePort: async () => 43_210,
    resolveCwd: () => '/tmp',
    spawnProcess: () => child,
    startupTimeoutMs: 20,
    gracefulTimeoutMs: 5,
    forceTimeoutMs: 5,
  })
}

class FakeServerProcess extends EventEmitter implements OpenCodeServerProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: NodeJS.Signals[] = []
  exitCode: number | null = null
  exitOnKill: NodeJS.Signals | null = 'SIGTERM'

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (this.exitOnKill === signal) {
      this.exitCode = 0
      queueMicrotask(() => this.emit('exit', 0))
    }
    return true
  }
}
