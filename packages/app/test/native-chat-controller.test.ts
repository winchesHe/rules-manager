import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from '@jest/globals'
import Database from 'better-sqlite3'
import { initDatabase } from '../../core/src/db.js'
import { ChatStore } from '../main/chat-store.js'
import {
  ChatRuntimeManager,
  type ChatProviderAdapter,
} from '../main/chat-runtime.js'
import { NativeChatController } from '../main/native-chat-controller.js'

const roots: string[] = []

function createEvidenceSession(root: string): void {
  fs.mkdirSync(path.join(root, '.memory-manager'), { recursive: true })
  const sourcePath = path.join(root, 'session-evidence.jsonl')
  fs.writeFileSync(sourcePath, `${JSON.stringify({
    role: 'user', content: '总结时先核对 Coverage', timestamp: '2026-08-09T00:00:00Z',
  })}\n`)
  const db = initDatabase(root)
  db.prepare(`
    INSERT INTO sessions (
      id, agent, source_path, workspace_link, slug, content_hash, updated_at,
      status, first_seen_at, last_seen_at
    ) VALUES ('session-evidence', 'codex', ?, '/tmp/link', 'demo', 'hash',
      '2026-08-09', 'updated', '2026-08-09', '2026-08-09')
  `).run(sourcePath)
  db.close()
}

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

  it('启用 Evidence 时，无 Session Context 的普通 Chat 不增加隐藏调用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-no-evidence-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    const requests: string[] = []
    const controller = new NativeChatController({
      store,
      runtime: new ChatRuntimeManager((): ChatProviderAdapter => ({
        start: async (request) => {
          requests.push(request.message)
          return { nativeSessionId: 'native-plain', content: '普通回答' }
        },
        resume: async () => { throw new Error('不应 resume') },
        interrupt: async () => undefined,
        readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
        archive: async () => undefined,
        unarchive: async () => undefined,
        delete: async () => undefined,
        close: async () => undefined,
      })),
      workingDirectory: root,
      createId: () => 'chat-plain-evidence-enabled',
      enableSessionEvidence: true,
      sessionEvidenceHomeDir: root,
    })

    await controller.send({
      provider: 'codex', message: '普通聊天',
      config: { effort: 'medium', fastMode: false },
    })

    expect(requests).toEqual(['普通聊天'])
    expect(store.readThread('chat-plain-evidence-enabled')?.messages.at(-1)).toMatchObject({
      content: '普通回答',
    })
  })

  it.each([
    { question: '总结这些 Session 的经验', expectedStatus: 'complete' },
    { question: '找一下之前提到的 Coverage 要求', expectedStatus: 'targeted' },
  ])('Session Context 自动规划并走 Evidence：$expectedStatus', async ({ question, expectedStatus }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-live-evidence-'))
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-live-evidence-context-'))
    roots.push(root, tempParent)
    createEvidenceSession(root)
    const store = new ChatStore(path.join(root, 'chats'))
    const requests: Array<{ chatId: string; message: string }> = []
    const closed: string[] = []
    const progressStages: string[] = []
    const runtime = new ChatRuntimeManager((_provider, chatId): ChatProviderAdapter => ({
      start: async (request) => {
        requests.push({ chatId, message: request.message })
        if (request.message.includes('[memory-manager:live-evidence-map]')) {
          expect(request.toolPolicy).toBe('none')
          expect(request.mentions).toBeUndefined()
          const sourceRevision = request.message.match(/\\"sourceRevision\\":\\"([^\\"]+)\\"/)?.[1]
          if (!sourceRevision) throw new Error('source revision is required')
          return {
            nativeSessionId: 'native-map',
            content: '',
            structuredOutput: {
              sessionId: 'session-evidence',
              agent: 'codex',
              chunkIndex: 0,
              chunkCount: 1,
              summary: '先核对 Coverage',
              facts: [{
                id: 'fact-coverage',
                text: '总结时先核对 Coverage',
                kind: 'explicit',
                locators: [{
                  sessionId: 'session-evidence', agent: 'codex', messageIndex: 0, sourceRevision,
                }],
              }],
              relevant: true,
            },
          }
        }
        if (!request.message.includes('[memory-manager:live-evidence-reduce]')) {
          throw new Error('unexpected ordinary provider turn')
        }
        return {
          nativeSessionId: 'native-current-evidence',
          nativeSessionHandle: {
            sessionId: 'native-current-evidence', nativeHandle: 'handle-current-evidence',
          },
          content: '',
          structuredOutput: {
            answerMarkdown: '证据表明总结前应核对 Coverage。',
            claims: [{ text: '总结前核对 Coverage', evidenceFactIds: ['fact-coverage'] }],
            limitations: [],
          },
        }
      },
      resume: async () => { throw new Error('不应 resume') },
      interrupt: async () => undefined,
      readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
      archive: async () => undefined,
      unarchive: async () => undefined,
      delete: async () => undefined,
      close: async () => { closed.push(chatId) },
    }))
    const controller = new NativeChatController({
      store,
      runtime,
      workingDirectory: root,
      createId: () => `chat-evidence-${expectedStatus}`,
      now: () => '2026-08-09T10:00:00.000Z',
      enableSessionEvidence: true,
      sessionEvidenceHomeDir: root,
      sessionEvidenceTempParentDir: tempParent,
      onEvent: ({ event }) => {
        if (event.type === 'evidence_progress') progressStages.push(event.progress.stage)
      },
    })

    const result = await controller.send({
      provider: 'codex',
      message: question,
      config: { effort: 'medium', fastMode: false },
      sessionContext: [{ agent: 'codex', id: 'session-evidence' }],
    })

    expect(result.nativeSessionId).toBe('native-current-evidence')
    expect(requests).toHaveLength(2)
    expect(requests[0].message).toContain('[memory-manager:live-evidence-map]')
    expect(requests[1].message).toContain(`"status":"${expectedStatus}"`)
    expect(requests.every((request) => !request.message.includes('<host_session_context'))).toBe(true)
    const answer = store.readThread(`chat-evidence-${expectedStatus}`)?.messages.at(-1)?.content
    if (expectedStatus === 'targeted') {
      expect(answer).toContain('仅基于本次处理的证据')
    } else {
      expect(answer).toBe('证据表明总结前应核对 Coverage。')
    }
    expect(store.readThread(`chat-evidence-${expectedStatus}`)).toMatchObject({
      nativeSessionId: 'native-current-evidence',
      nativeSessionHandle: { nativeHandle: 'handle-current-evidence' },
      sessionContext: { revision: 1, lastInjectedRevision: 1 },
      messages: [
        { role: 'user' },
        { role: 'assistant', sessionEvidence: { status: expectedStatus, selected: 1, processed: 1 } },
      ],
    })
    expect(progressStages).toEqual([
      'planning', 'reading', 'reading', 'processing', 'processing',
      'reducing', 'gating', 'complete',
    ])
    expect(closed).toEqual([expect.stringMatching(/:map:/)])
    expect(fs.readdirSync(tempParent)).toEqual([])
  })

  it('取消 Evidence Map 时中断内部 Provider job、清理 Context 且不写伪完成消息', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-evidence-cancel-'))
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-evidence-cancel-context-'))
    roots.push(root, tempParent)
    createEvidenceSession(root)
    const store = new ChatStore(path.join(root, 'chats'))
    const progressStages: string[] = []
    const interrupted: string[] = []
    const runtime = new ChatRuntimeManager((_provider, chatId): ChatProviderAdapter => {
      let rejectActive: ((error: Error) => void) | undefined
      return {
        start: async (request) => {
          if (!request.message.includes('[memory-manager:live-evidence-map]')) {
            throw new Error('unexpected non-map turn')
          }
          return new Promise((_resolve, reject) => { rejectActive = reject })
        },
        resume: async () => { throw new Error('不应 resume') },
        interrupt: async () => {
          interrupted.push(chatId)
          const error = new Error('provider interrupted')
          error.name = 'AbortError'
          rejectActive?.(error)
        },
        readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
        archive: async () => undefined,
        unarchive: async () => undefined,
        delete: async () => undefined,
        close: async () => undefined,
      }
    })
    const controller = new NativeChatController({
      store,
      runtime,
      workingDirectory: root,
      createId: () => 'chat-evidence-cancel',
      enableSessionEvidence: true,
      sessionEvidenceHomeDir: root,
      sessionEvidenceTempParentDir: tempParent,
      onEvent: ({ event }) => {
        if (event.type === 'evidence_progress') progressStages.push(event.progress.stage)
      },
    })

    const pending = controller.send({
      provider: 'codex',
      message: '总结所有 Session',
      config: { effort: 'medium', fastMode: false },
      sessionContext: [{ agent: 'codex', id: 'session-evidence' }],
    })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'RUN_CANCELLED' })
    while (runtime.activeChatIds().length === 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }

    await controller.interrupt('chat-evidence-cancel')
    await rejected

    expect(interrupted).toEqual([expect.stringMatching(/:map:/)])
    expect(runtime.activeChatIds()).toEqual([])
    expect(fs.readdirSync(tempParent)).toEqual([])
    expect(progressStages.at(-1)).toBe('cancelled')
    expect(store.readThread('chat-evidence-cancel')).toMatchObject({
      status: 'interrupted',
      lastError: null,
      sessionContext: { revision: 1, lastInjectedRevision: 0 },
      messages: [{ role: 'user' }],
    })
    expect(store.readThread('chat-evidence-cancel')?.messages).toHaveLength(1)
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

  it('Scope 排除当前 Chat、Rules Generation 与内部 Evidence Session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-evidence-scope-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    const config = { effort: 'medium' as const, fastMode: false }
    store.createNativeThread({
      id: 'chat-scope', provider: 'codex', origin: 'chat', title: 'scope',
      createdAt: '2026-08-09T00:00:00.000Z', defaultTurnConfig: config,
    })
    store.bindNativeSession('chat-scope', 'native-current', '2026-08-09T00:00:01.000Z')
    store.createNativeThread({
      id: 'rules-scope', provider: 'claude', origin: 'rules', title: 'rules',
      createdAt: '2026-08-09T00:00:00.000Z', defaultTurnConfig: config,
      intent: 'rules-generation',
    })
    store.bindNativeSession('rules-scope', 'native-rules', '2026-08-09T00:00:01.000Z')
    store.recordInternalEvidenceSession('opencode', 'native-internal', '2026-08-09T00:00:02.000Z')
    const controller = new NativeChatController({
      store,
      runtime: new ChatRuntimeManager(() => { throw new Error('不应调用 Provider') }),
      workingDirectory: root,
      enableSessionEvidence: true,
    })

    const context = controller.updateSessionContext('chat-scope', [
      { agent: 'codex', id: 'native-current' },
      { agent: 'claude', id: 'native-rules' },
      { agent: 'opencode', id: 'native-internal' },
      { agent: 'pi', id: 'safe-session' },
    ])

    expect(context.selected).toEqual([{ agent: 'pi', id: 'safe-session' }])
    expect(store.sessionEvidenceExclusions('chat-scope')).toEqual(expect.arrayContaining([
      { agent: 'codex', id: 'native-current' },
      { agent: 'claude', id: 'native-rules' },
      { agent: 'opencode', id: 'native-internal' },
    ]))
  })

  it('只在 Assistant Turn 成功落盘后发送完成通知', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-completion-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    const completed: string[] = []
    let shouldFail = false
    const adapter: ChatProviderAdapter = {
      start: async () => {
        if (shouldFail) throw new Error('provider failed')
        return { nativeSessionId: 'native-completion', content: 'done' }
      },
      resume: async (request) => {
        if (shouldFail) throw new Error('provider failed')
        return { nativeSessionId: request.nativeSessionId, content: 'done again' }
      },
      interrupt: async () => undefined,
      readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
      archive: async () => undefined,
      unarchive: async () => undefined,
      delete: async () => undefined,
      close: async () => undefined,
    }
    const controller = new NativeChatController({
      store,
      runtime: new ChatRuntimeManager(() => adapter),
      workingDirectory: '/fixed-workspace',
      createId: () => 'chat-completion',
      now: () => '2026-08-04T12:00:00.000Z',
      onTurnCompleted: (chatId) => completed.push(chatId),
    })

    await controller.send({
      provider: 'codex', message: 'first', config: { effort: 'medium', fastMode: false },
    })
    expect(completed).toEqual(['chat-completion'])
    expect(store.readThread('chat-completion')?.messages.at(-1)).toMatchObject({
      role: 'assistant', content: 'done', status: 'completed',
    })

    shouldFail = true
    await expect(controller.send({
      chatId: 'chat-completion', provider: 'codex', message: 'second',
      config: { effort: 'medium', fastMode: false },
    })).rejects.toThrow('provider failed')
    expect(completed).toEqual(['chat-completion'])
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

  it('Codex 大型 Session Context 在 Turn 期间使用临时 mention，成功或失败后都清理', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-context-attachment-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    const attachmentPaths: string[] = []
    let attempts = 0
    const adapter: ChatProviderAdapter = {
      start: async (request) => {
        const attachmentPath = request.mentions?.[0]?.path
        expect(attachmentPath).toBeDefined()
        expect(fs.existsSync(attachmentPath!)).toBe(true)
        expect(fs.readFileSync(attachmentPath!, 'utf8')).toContain('session-79')
        expect(request.message).not.toContain('memory-manager sessions show session-79')
        attachmentPaths.push(attachmentPath!)
        attempts++
        if (attempts === 1) throw new Error('provider failed')
        return { nativeSessionId: 'native-attachment', content: 'done' }
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
      createId: () => 'chat-context-attachment', now: () => '2026-08-01T04:30:00.000Z',
    })
    const sessionContext = Array.from({ length: 80 }, (_, index) => ({
      agent: 'codex' as const,
      id: `session-${index}`,
    }))

    await expect(controller.send({
      provider: 'codex', message: 'first', config: { effort: 'high', fastMode: false },
      sessionContext,
    })).rejects.toThrow('provider failed')
    expect(fs.existsSync(attachmentPaths[0])).toBe(false)

    await controller.send({
      chatId: 'chat-context-attachment', provider: 'codex', message: 'retry',
      config: { effort: 'high', fastMode: false },
    })
    expect(attachmentPaths).toHaveLength(2)
    expect(fs.existsSync(attachmentPaths[1])).toBe(false)
    expect(store.readThread('chat-context-attachment')).toMatchObject({
      sessionContext: { revision: 1, lastInjectedRevision: 1 },
    })
  })

  it('Codex 支持纯粘贴文本附件，并且只持久化附件元数据', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-pasted-text-'))
    roots.push(root)
    const store = new ChatStore(path.join(root, 'chats'))
    let attachmentPath = ''
    const pastedText = 'p'.repeat(5_000)
    const adapter: ChatProviderAdapter = {
      start: async (request) => {
        attachmentPath = request.mentions?.[0]?.path ?? ''
        expect(fs.readFileSync(attachmentPath, 'utf8')).toBe(pastedText)
        expect(request.message).not.toContain(pastedText)
        return { nativeSessionId: 'native-pasted-text', content: 'done' }
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
      createId: () => 'chat-pasted-text', now: () => '2026-08-01T04:40:00.000Z',
    })

    await controller.send({
      provider: 'codex', message: '', config: { effort: 'high', fastMode: false },
      pastedTextAttachments: [{
        name: 'Pasted text.txt', text: pastedText, characterCount: pastedText.length,
      }],
    })

    expect(fs.existsSync(attachmentPath)).toBe(false)
    const persisted = store.readThread('chat-pasted-text')
    expect(persisted?.messages[0]).toMatchObject({
      role: 'user', content: '',
      attachments: [{ kind: 'pasted-text', name: 'Pasted text.txt', characterCount: 5_000 }],
    })
    expect(JSON.stringify(persisted)).not.toContain(pastedText)
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

  it('停止 Rules Chat 会取消前置扫描并落为中断而不是失败', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-native-rules-cancel-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, '.memory-manager'), { recursive: true })
    initDatabase(root).close()
    const store = new ChatStore(path.join(root, '.memory-manager', 'chats'))
    let receivedSignal: AbortSignal | undefined
    const controller = new NativeChatController({
      store,
      runtime: new ChatRuntimeManager((): ChatProviderAdapter => ({
        start: async () => { throw new Error('provider 不应在扫描完成前启动') },
        resume: async () => { throw new Error('provider 不应在扫描完成前恢复') },
        interrupt: async () => undefined,
        readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
        archive: async () => undefined,
        unarchive: async () => undefined,
        delete: async () => undefined,
        close: async () => undefined,
      })),
      workingDirectory: root,
      sessionEvidenceHomeDir: root,
      createId: () => 'rules-cancel-preflight',
      now: () => '2026-08-10T03:00:00.000Z',
      scanSessions: (_sinceDays, signal) => {
        receivedSignal = signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('扫描等待已停止')), {
            once: true,
          })
        })
      },
    })

    const started = controller.startRulesGeneration({
      mode: 'changed7d', projects: [], provider: 'opencode',
      effort: 'medium', fastMode: false,
    })
    expect(receivedSignal?.aborted).toBe(false)

    await controller.interrupt(started.chatId)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(receivedSignal?.aborted).toBe(true)
    expect(store.readThread(started.chatId)).toMatchObject({
      status: 'interrupted',
      lastError: null,
      messages: [{ role: 'user' }],
    })
    const db = new Database(path.join(root, '.memory-manager', 'memory.db'), {
      readonly: true,
    })
    try {
      expect(db.prepare('SELECT status FROM run_metadata WHERE id = ?').get(started.runId))
        .toEqual({ status: 'cancelled' })
    } finally {
      db.close()
    }
  })
})
