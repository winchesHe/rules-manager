import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from '@jest/globals'
import { ChatStore } from '../main/chat-store.js'
import {
  ChatRuntimeManager,
  type ChatProviderAdapter,
} from '../main/chat-runtime.js'
import { NativeChatController } from '../main/native-chat-controller.js'

const roots: string[] = []

describe('NativeChatController', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('首次发送才创建 Chat，后续与重启后保持同一 Native Session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-chat-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    const calls: string[] = []
    const adapter = (): ChatProviderAdapter => ({
      start: async (request) => {
        calls.push(`start:${request.message}`)
        return { nativeSessionId: 'native-fixed', content: 'first reply' }
      },
      resume: async (request) => {
        calls.push(`resume:${request.nativeSessionId}:${request.message}`)
        return { nativeSessionId: request.nativeSessionId, content: 'continued reply' }
      },
      interrupt: async () => undefined,
      close: async () => undefined,
    })
    const createController = () => new NativeChatController({
      store,
      runtime: new ChatRuntimeManager(adapter),
      workingDirectory: '/fixed-workspace',
      createId: () => 'chat-fixed',
      now: () => '2026-08-01T02:00:00.000Z',
    })

    expect(store.listThreads()).toEqual([])
    const first = await createController().send({
      provider: 'claude', message: 'first',
      config: { effort: 'high', fastMode: false },
    })
    expect(first.chatId).toBe('chat-fixed')
    expect(store.readThread('chat-fixed')).toMatchObject({
      nativeSessionId: 'native-fixed', provider: 'claude', status: 'ready',
      messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'first reply' }],
    })

    await createController().send({
      chatId: 'chat-fixed', provider: 'claude', message: 'second',
      config: { effort: 'medium', fastMode: true },
    })
    await createController().send({
      chatId: 'chat-fixed', provider: 'claude', message: 'third after restart',
      config: { effort: 'low', fastMode: false },
    })
    expect(calls).toEqual([
      'start:first',
      'resume:native-fixed:second',
      'resume:native-fixed:third after restart',
    ])
    expect(store.readThread('chat-fixed')?.messages).toHaveLength(6)
  })

  it('首轮后拒绝切换 Provider', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-chat-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    store.createNativeThread({
      id: 'chat-locked', provider: 'claude', origin: 'chat', title: 'locked',
      createdAt: '2026-08-01T02:00:00.000Z',
      defaultTurnConfig: { effort: 'high', fastMode: false },
    })
    store.bindNativeSession('chat-locked', 'native-fixed', '2026-08-01T02:00:01.000Z')
    const controller = new NativeChatController({
      store,
      runtime: new ChatRuntimeManager(() => { throw new Error('must not run') }),
      workingDirectory: '/fixed-workspace',
    })

    await expect(controller.send({
      chatId: 'chat-locked', provider: 'codex', message: 'switch',
      config: { effort: 'high', fastMode: false },
    })).rejects.toThrow('provider is locked')
  })
})
