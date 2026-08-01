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
    const streamed: unknown[] = []
    const adapter = (): ChatProviderAdapter => ({
      start: async (request) => {
        calls.push(`start:${request.message}`)
        request.onEvent?.({ type: 'assistant_delta', text: 'first ' })
        request.onEvent?.({
          type: 'tool_activity',
          activity: {
            itemId: 'tool-safe-1', kind: 'read', name: 'Read', status: 'completed',
            summary: '/fixed-workspace/README.md',
          },
        })
        return {
          nativeSessionId: 'native-fixed',
          content: 'first reply',
          contextUsage: { usedTokens: 1234, maxTokens: 200000 },
        }
      },
      resume: async (request) => {
        calls.push(`resume:${request.nativeSessionId}:${request.message}`)
        return { nativeSessionId: request.nativeSessionId, content: 'continued reply' }
      },
      interrupt: async () => undefined,
      readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
      close: async () => undefined,
    })
    const createController = () => new NativeChatController({
      store,
      runtime: new ChatRuntimeManager(adapter),
      workingDirectory: '/fixed-workspace',
      createId: () => 'chat-fixed',
      now: () => '2026-08-01T02:00:00.000Z',
      onEvent: (event) => streamed.push(event),
    })

    expect(store.listThreads()).toEqual([])
    const first = await createController().send({
      provider: 'claude', message: 'first',
      config: { effort: 'high', fastMode: false },
    })
    expect(first.chatId).toBe('chat-fixed')
    expect(store.readThread('chat-fixed')).toMatchObject({
      nativeSessionId: 'native-fixed', provider: 'claude', status: 'ready',
      contextUsage: { usedTokens: 1234, maxTokens: 200000 },
      messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'first reply' }],
    })
    expect(store.readThread('chat-fixed')?.messages[1]).toMatchObject({
      toolActivities: [{ itemId: 'tool-safe-1', summary: '/fixed-workspace/README.md' }],
    })
    expect(streamed).toContainEqual({
      chatId: 'chat-fixed',
      event: { type: 'assistant_delta', text: 'first ' },
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

  it('只允许按已持久化的安全工具引用懒加载原生详情', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-chat-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    store.createNativeThread({
      id: 'chat-tool', provider: 'claude', origin: 'chat', title: 'tool',
      createdAt: '2026-08-01T02:00:00.000Z',
      defaultTurnConfig: { effort: 'high', fastMode: false },
    })
    store.bindNativeSession('chat-tool', 'native-tool-session', '2026-08-01T02:00:01.000Z')
    store.appendNativeMessage('chat-tool', {
      id: 'assistant-1', role: 'assistant', kind: 'text', content: 'done', status: 'completed',
      createdAt: '2026-08-01T02:00:02.000Z', completedAt: '2026-08-01T02:00:02.000Z',
      toolActivities: [{
        itemId: 'allowed-item', kind: 'read', name: 'Read', status: 'completed', summary: 'README.md',
      }],
    })
    const adapter: ChatProviderAdapter = {
      start: async () => { throw new Error('unexpected start') },
      resume: async () => { throw new Error('unexpected resume') },
      interrupt: async () => undefined,
      readToolItem: async (request) => ({
        available: true,
        content: `${request.nativeSessionId}:${request.itemId}:${request.cursor ?? 0}`,
        nextCursor: null,
      }),
      close: async () => undefined,
    }
    const controller = new NativeChatController({
      store, runtime: new ChatRuntimeManager(() => adapter), workingDirectory: '/fixed-workspace',
    })

    await expect(controller.readToolItem({
      chatId: 'chat-tool', itemId: 'allowed-item', cursor: 4, limit: 128,
    })).resolves.toMatchObject({ content: 'native-tool-session:allowed-item:4' })
    await expect(controller.readToolItem({
      chatId: 'chat-tool', itemId: 'unknown-item', cursor: 0, limit: 128,
    })).rejects.toThrow('tool item was not found')
  })
})
