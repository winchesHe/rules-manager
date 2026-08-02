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
        request.onEvent?.({ type: 'assistant_delta', itemId: 'message-1', text: 'first ' })
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
      archive: async () => undefined,
      unarchive: async () => undefined,
      delete: async () => undefined,
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
      event: { type: 'assistant_delta', itemId: 'message-1', text: 'first ', content: 'first ' },
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

  it('发送后立即暴露用户消息，并用本轮起止时间保存 Assistant 与累计流式正文', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-live-turn-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    const changed: string[] = []
    const streamed: unknown[] = []
    let release!: () => void
    const providerGate = new Promise<void>((resolve) => { release = resolve })
    const adapter: ChatProviderAdapter = {
      start: async (request) => {
        request.onEvent?.({ type: 'assistant_delta', itemId: 'message-1', text: '你' })
        request.onEvent?.({ type: 'assistant_delta', itemId: 'message-1', text: '好' })
        await providerGate
        return { nativeSessionId: 'native-live', content: '你好' }
      },
      resume: async () => { throw new Error('unexpected resume') },
      interrupt: async () => undefined,
      readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
      archive: async () => undefined,
      unarchive: async () => undefined,
      delete: async () => undefined,
      close: async () => undefined,
    }
    const times = [
      '2026-08-02T12:00:00.000Z',
      '2026-08-02T12:00:01.000Z',
      '2026-08-02T12:00:06.000Z',
      '2026-08-02T12:00:06.000Z',
    ]
    const controller = new NativeChatController({
      store,
      runtime: new ChatRuntimeManager(() => adapter),
      workingDirectory: '/fixed-workspace',
      createId: () => 'chat-live',
      now: () => times.shift() ?? '2026-08-02T12:00:06.000Z',
      onEvent: (event) => streamed.push(event),
      onThreadChanged: (chatId) => changed.push(chatId),
    })

    const pending = controller.send({
      provider: 'codex', message: '开始',
      config: { effort: 'medium', fastMode: false },
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(changed).toEqual(['chat-live'])
    expect(store.readThread('chat-live')).toMatchObject({
      status: 'running',
      messages: [{ role: 'user', content: '开始', createdAt: '2026-08-02T12:00:01.000Z' }],
    })
    expect(streamed).toEqual([
      { chatId: 'chat-live', event: { type: 'assistant_delta', itemId: 'message-1', text: '你', content: '你' } },
      { chatId: 'chat-live', event: { type: 'assistant_delta', itemId: 'message-1', text: '好', content: '你好' } },
    ])

    release()
    await pending
    expect(changed).toEqual(['chat-live', 'chat-live'])
    expect(store.readThread('chat-live')?.messages.at(-1)).toMatchObject({
      role: 'assistant', content: '你好',
      createdAt: '2026-08-02T12:00:01.000Z',
      completedAt: '2026-08-02T12:00:06.000Z',
    })
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
        sourceLocator: { turnId: 'native-turn', toolIndex: 2 },
      }, {
        itemId: 'legacy-item', kind: 'shell', name: 'Command', status: 'completed', summary: 'pwd',
      }, {
        itemId: 'message-item', kind: 'tool', name: 'agentMessage', status: 'completed',
      }],
    })
    const toolReads: Array<{ sourceLocator?: unknown }> = []
    const adapter: ChatProviderAdapter = {
      start: async () => { throw new Error('unexpected start') },
      resume: async () => { throw new Error('unexpected resume') },
      interrupt: async () => undefined,
      readToolItem: async (request) => {
        toolReads.push(request)
        return {
          available: true,
          content: `${request.nativeSessionId}:${request.itemId}:${request.cursor ?? 0}`,
          nextCursor: null,
        }
      },
      archive: async () => undefined,
      unarchive: async () => undefined,
      delete: async () => undefined,
      close: async () => undefined,
    }
    const controller = new NativeChatController({
      store, runtime: new ChatRuntimeManager(() => adapter), workingDirectory: '/fixed-workspace',
    })

    expect(store.readThread('chat-tool')?.messages.at(-1)?.toolActivities).toEqual([{
      itemId: 'allowed-item', kind: 'read', name: 'Read', status: 'completed', summary: 'README.md',
      sourceLocator: { turnId: 'native-turn', toolIndex: 2 },
    }, {
      itemId: 'legacy-item', kind: 'shell', name: 'Command', status: 'completed', summary: 'pwd',
    }])

    await expect(controller.readToolItem({
      chatId: 'chat-tool', itemId: 'allowed-item', cursor: 4, limit: 128,
    })).resolves.toMatchObject({ content: 'native-tool-session:allowed-item:4' })
    expect(toolReads).toEqual([expect.objectContaining({
      sourceLocator: { turnId: 'native-turn', toolIndex: 2 },
    })])
    await controller.readToolItem({ chatId: 'chat-tool', itemId: 'legacy-item' })
    expect(toolReads.at(-1)).toEqual(expect.objectContaining({
      sourceLocator: { turnIndex: 0, toolIndex: 1 },
    }))
    await expect(controller.readToolItem({
      chatId: 'chat-tool', itemId: 'unknown-item', cursor: 0, limit: 128,
    })).rejects.toThrow('tool item was not found')
    await expect(controller.readToolItem({
      chatId: 'chat-tool', itemId: 'message-item', cursor: 0, limit: 128,
    })).rejects.toThrow('tool item was not found')
  })

  it('将交错的 Assistant、Thinking 与 Tool 按发生顺序持久化', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-order-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    const adapter: ChatProviderAdapter = {
      start: async (request) => {
        request.onEvent?.({
          type: 'assistant_delta', itemId: 'commentary', text: '先检查。',
        })
        request.onEvent?.({
          type: 'tool_activity',
          activity: { itemId: 'tool-1', kind: 'read', name: 'Read', status: 'running' },
        })
        request.onEvent?.({
          type: 'thinking_delta', itemId: 'thinking-1', text: '继续确认。',
        })
        request.onEvent?.({
          type: 'tool_activity',
          activity: { itemId: 'tool-1', kind: 'read', name: 'Read', status: 'completed' },
        })
        request.onEvent?.({
          type: 'assistant_delta', itemId: 'final', text: '最终结论。',
        })
        return { nativeSessionId: 'native-order', content: '先检查。最终结论。' }
      },
      resume: async () => { throw new Error('unexpected resume') },
      interrupt: async () => undefined,
      readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
      archive: async () => undefined,
      unarchive: async () => undefined,
      delete: async () => undefined,
      close: async () => undefined,
    }
    const controller = new NativeChatController({
      store, runtime: new ChatRuntimeManager(() => adapter), workingDirectory: '/fixed-workspace',
      createId: () => 'chat-order', now: () => '2026-08-03T01:00:00.000Z',
    })

    await controller.send({
      provider: 'codex', message: '检查', config: { effort: 'high', fastMode: false },
    })

    const assistant = store.readThread('chat-order')?.messages.at(-1)
    expect(assistant?.timeline?.map((item) => `${item.type}:${item.itemId}`)).toEqual([
      'assistant:commentary',
      'tool:tool-1',
      'thinking:thinking-1',
      'assistant:final',
    ])
    expect(assistant?.timeline?.[1]).toMatchObject({
      type: 'tool', activity: { status: 'completed' },
    })
    expect(assistant?.timeline?.[2]).toMatchObject({ status: 'completed' })
  })

  it('只在首次选择或集合变化后注入完整 Session Context，且隐藏块不落可见消息', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-context-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    const providerMessages: string[] = []
    const adapter: ChatProviderAdapter = {
      start: async (request) => {
        providerMessages.push(request.message)
        return { nativeSessionId: 'native-context', content: 'first' }
      },
      resume: async (request) => {
        providerMessages.push(request.message)
        return { nativeSessionId: request.nativeSessionId, content: 'next' }
      },
      interrupt: async () => undefined,
      readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
      archive: async () => undefined,
      unarchive: async () => undefined,
      delete: async () => undefined,
      close: async () => undefined,
    }
    let tick = 0
    const controller = new NativeChatController({
      store, runtime: new ChatRuntimeManager(() => adapter), workingDirectory: '/fixed-workspace',
      createId: () => 'chat-context',
      now: () => `2026-08-01T03:00:0${tick++}.000Z`,
    })
    await controller.send({
      provider: 'claude', message: 'first visible',
      config: { effort: 'high', fastMode: false },
      sessionContext: [{ agent: 'claude', id: 's-1' }],
    })
    await controller.send({
      chatId: 'chat-context', provider: 'claude', message: 'same visible',
      config: { effort: 'high', fastMode: false },
    })
    controller.updateSessionContext('chat-context', [
      { agent: 'codex', id: 's-2' },
    ])
    await controller.send({
      chatId: 'chat-context', provider: 'claude', message: 'changed visible',
      config: { effort: 'high', fastMode: false },
    })

    expect(providerMessages[0]).toContain('<host_session_context version="1" revision="1" mode="replace">')
    expect(providerMessages[0]).toContain('memory-manager sessions show s-1 --stream')
    expect(providerMessages[1]).toBe('same visible')
    expect(providerMessages[2]).toContain('<added><session agent="codex" id="s-2" /></added>')
    expect(providerMessages[2]).toContain('<removed><session agent="claude" id="s-1" /></removed>')
    const persisted = JSON.stringify(store.readThread('chat-context'))
    expect(persisted).toContain('first visible')
    expect(persisted).toContain('changed visible')
    expect(persisted).not.toContain('host_session_context')
    expect(store.readThread('chat-context')).toMatchObject({
      sessionContext: { revision: 2, lastInjectedRevision: 2 },
    })
  })

  it('Provider 失败时不提交 injected revision，下一轮会重试同一隐藏块', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-context-retry-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    const providerMessages: string[] = []
    let attempts = 0
    const adapter: ChatProviderAdapter = {
      start: async (request) => {
        providerMessages.push(request.message)
        attempts++
        if (attempts === 1) throw new Error('provider failed')
        return { nativeSessionId: 'native-retry', content: 'done' }
      },
      resume: async () => { throw new Error('unexpected resume') },
      interrupt: async () => undefined,
      readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
      archive: async () => undefined,
      unarchive: async () => undefined,
      delete: async () => undefined,
      close: async () => undefined,
    }
    const controller = new NativeChatController({
      store, runtime: new ChatRuntimeManager(() => adapter), workingDirectory: '/fixed-workspace',
      createId: () => 'chat-context-retry', now: () => '2026-08-01T04:00:00.000Z',
    })
    await expect(controller.send({
      provider: 'claude', message: 'first', config: { effort: 'high', fastMode: false },
      sessionContext: [{ agent: 'codex', id: 's-retry' }],
    })).rejects.toThrow('provider failed')
    expect(store.readThread('chat-context-retry')).toMatchObject({
      sessionContext: { revision: 1, lastInjectedRevision: 0 },
    })
    await controller.send({
      chatId: 'chat-context-retry', provider: 'claude', message: 'retry',
      config: { effort: 'high', fastMode: false },
    })
    expect(providerMessages).toHaveLength(2)
    expect(providerMessages.every((message) => message.includes('revision="1"'))).toBe(true)
  })

  it('生命周期先同步 Native，再改本地；删除失败保留 Archived 记录重试', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-lifecycle-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    store.createNativeThread({
      id: 'chat-life', provider: 'codex', origin: 'chat', title: 'before',
      createdAt: '2026-08-01T05:00:00.000Z',
      defaultTurnConfig: { effort: 'high', fastMode: false },
    })
    store.bindNativeSession('chat-life', 'native-life', '2026-08-01T05:00:01.000Z')
    const calls: string[] = []
    let deleteFails = true
    const adapter: ChatProviderAdapter = {
      start: async () => { throw new Error('unexpected start') },
      resume: async () => { throw new Error('unexpected resume') },
      interrupt: async () => { calls.push('interrupt') },
      readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
      archive: async (id) => { calls.push(`archive:${id}`) },
      unarchive: async (id) => { calls.push(`unarchive:${id}`) },
      delete: async (id) => {
        calls.push(`delete:${id}`)
        if (deleteFails) throw new Error('native delete failed')
      },
      close: async () => { calls.push('close') },
    }
    const controller = new NativeChatController({
      store, runtime: new ChatRuntimeManager(() => adapter), workingDirectory: '/fixed-workspace',
      now: () => '2026-08-01T05:00:02.000Z',
    })
    controller.rename('chat-life', 'after')
    controller.pin('chat-life')
    expect(store.readThread('chat-life')).toMatchObject({ pinnedAt: expect.any(String) })
    controller.unpin('chat-life')
    expect(store.readThread('chat-life')).toMatchObject({ pinnedAt: null })
    await controller.archive('chat-life')
    expect(store.readThread('chat-life')).toMatchObject({ title: 'after', archivedAt: expect.any(String) })
    await controller.unarchive('chat-life')
    await controller.archive('chat-life')
    await expect(controller.deleteArchived('chat-life')).rejects.toThrow('native delete failed')
    expect(store.readThread('chat-life')).not.toBeNull()
    deleteFails = false
    await controller.deleteArchived('chat-life')
    expect(store.readThread('chat-life')).toBeNull()
    expect(calls).toEqual([
      'archive:native-life', 'unarchive:native-life', 'archive:native-life',
      'delete:native-life', 'delete:native-life', 'close',
    ])
  })

  it('Native resume 失败保留原 Session ID 并进入可重试状态', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-resume-failure-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    store.createNativeThread({
      id: 'chat-resume-failure', provider: 'codex', origin: 'chat', title: 'resume',
      createdAt: '2026-08-01T06:00:00.000Z',
      defaultTurnConfig: { effort: 'high', fastMode: false },
    })
    store.bindNativeSession('chat-resume-failure', 'native-original', '2026-08-01T06:00:01.000Z')
    const adapter: ChatProviderAdapter = {
      start: async () => { throw new Error('unexpected start') },
      resume: async () => { throw new Error('native resume failed') },
      interrupt: async () => undefined,
      readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
      archive: async () => undefined,
      unarchive: async () => undefined,
      delete: async () => undefined,
      close: async () => undefined,
    }
    const controller = new NativeChatController({
      store, runtime: new ChatRuntimeManager(() => adapter), workingDirectory: '/fixed-workspace',
      now: () => '2026-08-01T06:00:02.000Z',
    })
    await expect(controller.send({
      chatId: 'chat-resume-failure', provider: 'codex', message: 'retry',
      config: { effort: 'high', fastMode: false },
    })).rejects.toThrow('native resume failed')
    expect(store.readThread('chat-resume-failure')).toMatchObject({
      nativeSessionId: 'native-original', nativeState: 'resume-failed', status: 'failed',
    })
  })
})
