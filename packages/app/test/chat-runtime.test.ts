import { describe, expect, it } from '@jest/globals'
import {
  ChatRuntimeManager,
  type ChatProviderAdapter,
  type NativeTurnRequest,
  type NativeTurnResult,
} from '../main/chat-runtime.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('ChatRuntimeManager', () => {
  it('同一 Chat 拒绝并发 turn，不同 Chat 可以并行', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<NativeTurnResult>>>()
    const adapter: ChatProviderAdapter = {
      start: (request) => {
        const gate = deferred<NativeTurnResult>()
        gates.set(request.chatId, gate)
        return gate.promise
      },
      resume: () => { throw new Error('unexpected resume') },
      interrupt: async () => undefined,
      readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
      close: async () => undefined,
    }
    const manager = new ChatRuntimeManager(() => adapter)
    const request = (chatId: string): NativeTurnRequest => ({
      chatId,
      provider: 'claude',
      message: 'hello',
      workingDirectory: '/workspace',
      config: { effort: 'high', fastMode: false },
    })

    const first = manager.sendTurn(request('chat-a'))
    await expect(manager.sendTurn(request('chat-a'))).rejects.toThrow('already has an active turn')
    const other = manager.sendTurn(request('chat-b'))
    expect(manager.activeChatIds()).toEqual(['chat-a', 'chat-b'])

    gates.get('chat-a')?.resolve({ nativeSessionId: 'session-a', content: 'a' })
    gates.get('chat-b')?.resolve({ nativeSessionId: 'session-b', content: 'b' })
    await expect(first).resolves.toMatchObject({ nativeSessionId: 'session-a' })
    await expect(other).resolves.toMatchObject({ nativeSessionId: 'session-b' })
    expect(manager.activeChatIds()).toEqual([])
  })

  it('已有 Native Session 时只能 resume，且中断定向到当前 Chat', async () => {
    const calls: string[] = []
    const gate = deferred<NativeTurnResult>()
    const adapter: ChatProviderAdapter = {
      start: () => { throw new Error('unexpected start') },
      resume: (request) => {
        calls.push(`resume:${request.nativeSessionId}`)
        return gate.promise
      },
      interrupt: async () => { calls.push('interrupt') },
      readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
      close: async () => undefined,
    }
    const manager = new ChatRuntimeManager(() => adapter)
    const running = manager.sendTurn({
      chatId: 'chat-a',
      provider: 'claude',
      nativeSessionId: 'native-existing',
      message: 'continue',
      workingDirectory: '/workspace',
      config: { model: 'claude-sonnet', effort: 'medium', fastMode: true },
    })

    await manager.interrupt('chat-a')
    expect(calls).toEqual(['resume:native-existing', 'interrupt'])
    gate.resolve({ nativeSessionId: 'native-existing', content: 'done' })
    await running
  })
})
