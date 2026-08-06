import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from '@jest/globals'
import { JsonlRpcProcess, type JsonlRpcChild } from '../main/jsonl-rpc-process.js'

describe('JsonlRpcProcess', () => {
  it('隔离非法 JSON，并能从分片行恢复响应', async () => {
    const child = new FakeChild()
    const rpc = createRpc(child)
    const response = rpc.request({ type: 'get_state' })
    const id = child.frames()[0]?.id

    child.stdout.write('not-json\n')
    child.stdout.write(`{"type":"response","id":"${id}",`)
    child.stdout.write('"success":true,"data":{"sessionId":"pi-1"}}\n')

    await expect(response).resolves.toEqual({ sessionId: 'pi-1' })
  })

  it('按 request id 关联乱序响应', async () => {
    const child = new FakeChild()
    const rpc = createRpc(child)
    const first = rpc.request({ type: 'first' })
    const second = rpc.request({ type: 'second' })
    const [firstFrame, secondFrame] = child.frames()

    child.respond(secondFrame.id, { value: 2 })
    child.respond(firstFrame.id, { value: 1 })

    await expect(Promise.all([first, second])).resolves.toEqual([{ value: 1 }, { value: 2 }])
  })

  it('无响应会超时，进程退出会一次拒绝所有 pending 且 stderr 有上限', async () => {
    const child = new FakeChild()
    const rpc = createRpc(child, { requestTimeoutMs: 5 })
    await expect(rpc.request({ type: 'never' })).rejects.toThrow('never 超时')

    child.stderr.write('x'.repeat(10_000))
    const one = rpc.request({ type: 'one' }, 100)
    const two = rpc.request({ type: 'two' }, 100)
    child.emit('exit', 9, null)
    await expect(one).rejects.toThrow(/Pi RPC exited \(9\): x+/)
    await expect(two).rejects.toThrow(/Pi RPC exited \(9\): x+/)
    expect(rpc.stderrTail.length).toBeLessThanOrEqual(8_192)
  })

  it('关闭时先 SIGTERM，未退出再 SIGKILL', async () => {
    const child = new FakeChild()
    child.exitOnKill = 'SIGKILL'
    const rpc = createRpc(child, { gracefulTimeoutMs: 5, forceTimeoutMs: 5 })

    await rpc.close()

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

function createRpc(
  child: FakeChild,
  options: Partial<ConstructorParameters<typeof JsonlRpcProcess>[0]> = {},
): JsonlRpcProcess {
  return new JsonlRpcProcess({
    name: 'Pi RPC',
    command: 'pi',
    args: ['--mode', 'rpc'],
    cwd: '/tmp',
    spawnProcess: () => child,
    ...options,
  })
}

class FakeChild extends EventEmitter implements JsonlRpcChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: NodeJS.Signals[] = []
  pid = 123
  exitOnKill: NodeJS.Signals | null = null
  private written = ''

  constructor() {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => { this.written += chunk })
  }

  frames(): Array<Record<string, string>> {
    return this.written
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => JSON.parse(line) as Record<string, string>)
  }

  respond(id: string, data: unknown): void {
    this.stdout.write(`${JSON.stringify({ type: 'response', id, success: true, data })}\n`)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (this.exitOnKill === signal) queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
}
