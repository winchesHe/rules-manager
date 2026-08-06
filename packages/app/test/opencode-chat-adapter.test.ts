import { describe, expect, it, jest } from '@jest/globals'
import { OpenCodeChatAdapter } from '../main/opencode-chat-adapter.js'
import type { NativeChatEvent } from '../main/chat-runtime.js'

describe('OpenCodeChatAdapter', () => {
  it('创建持久 Session，自动批准权限并转译流式/工具/结构化输出', async () => {
    const permissionReply = jest.fn(async () => ({ data: true }))
    const events = [
      { type: 'permission.asked', data: { id: 'permission-1', sessionID: 'oc-1' } },
      { type: 'message.part.delta', data: { sessionID: 'oc-1', partID: 'text-1', field: 'text', delta: 'hello' } },
      { type: 'message.part.updated', data: { sessionID: 'oc-1', part: { id: 'tool-1', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' } } } } },
      { type: 'message.updated', data: { sessionID: 'oc-1', info: { role: 'assistant', structured: { candidates: [] }, tokens: { total: 12 } } } },
      { type: 'session.idle', data: { sessionID: 'oc-1' } },
    ]
    const client = fakeClient(events, { permissionReply })
    const adapter = new OpenCodeChatAdapter({
      acquireServer: async () => ({ url: 'http://fake', release: async () => undefined }),
      createClient: () => client as never,
    })
    const emitted: NativeChatEvent[] = []
    const result = await adapter.start({
      chatId: 'chat-oc', provider: 'opencode', message: 'go', workingDirectory: '/tmp',
      config: { model: 'openai/gpt-test', effort: 'high', fastMode: false },
      outputSchema: { type: 'object' }, onEvent: (event) => emitted.push(event),
    })

    expect(result).toMatchObject({
      nativeSessionId: 'oc-1',
      nativeSessionHandle: { sessionId: 'oc-1', nativeHandle: 'oc-1' },
      content: 'hello', structuredOutput: { candidates: [] },
    })
    expect(permissionReply).toHaveBeenCalledWith(expect.objectContaining({ reply: 'always' }))
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'tool_activity' }))
  })

  it('把 question.asked 暴露为交互请求并回传答案', async () => {
    const questionReply = jest.fn(async () => ({ data: true }))
    const client = fakeClient([
      { type: 'question.asked', data: { id: 'q-1', sessionID: 'oc-1', questions: [{ header: 'Choice', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] } },
      { type: 'session.idle', data: { sessionID: 'oc-1' } },
    ], { questionReply })
    const adapter = new OpenCodeChatAdapter({
      acquireServer: async () => ({ url: 'http://fake', release: async () => undefined }),
      createClient: () => client as never,
    })
    const emitted: NativeChatEvent[] = []
    const resultPromise = adapter.start({
      chatId: 'chat-oc', provider: 'opencode', message: 'ask', workingDirectory: '/tmp',
      config: { effort: 'medium', fastMode: false }, onEvent: (event) => emitted.push(event),
    })
    for (let attempt = 0; attempt < 10 && emitted.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    await adapter.respondToInteraction({ requestId: 'q-1', answers: { Choice: ['A'] } })
    await resultPromise
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'interaction_request', request: expect.objectContaining({ requestId: 'q-1' }),
    }))
    expect(questionReply).toHaveBeenCalledWith(expect.objectContaining({ answers: [['A']] }))
  })

  it('恢复既有 Session，并严格忽略其他 Session 的嵌套事件', async () => {
    const create = jest.fn(async () => ({ data: { id: 'unexpected' } }))
    const promptAsync = jest.fn(async () => ({ data: true }))
    const client = fakeClient([
      { type: 'message.part.delta', data: { sessionID: 'other', partID: 'wrong', field: 'text', delta: 'wrong' } },
      { type: 'message.updated', data: { info: { sessionID: 'other', role: 'assistant', structured: { wrong: true } } } },
      { type: 'message.part.delta', data: { sessionID: 'oc-existing', partID: 'right', field: 'text', delta: 'target' } },
      { type: 'session.idle', data: { sessionID: 'oc-existing' } },
    ], { create, promptAsync })
    const adapter = new OpenCodeChatAdapter({
      acquireServer: async () => ({ url: 'http://fake', release: async () => undefined }),
      createClient: () => client as never,
    })

    const result = await adapter.resume({
      chatId: 'chat-oc', provider: 'opencode', nativeSessionId: 'oc-existing',
      nativeSessionHandle: { sessionId: 'oc-existing', nativeHandle: 'oc-existing' },
      message: 'resume', workingDirectory: '/tmp',
      config: { effort: 'medium', fastMode: false },
    })

    expect(create).not.toHaveBeenCalled()
    expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'oc-existing' }))
    expect(result.content).toBe('target')
    expect(result.structuredOutput).toBeUndefined()
  })

  it('SSE 在终态前正常 EOF 也会拒绝 turn', async () => {
    const client = fakeClient([
      { type: 'message.part.delta', data: { sessionID: 'oc-1', partID: 'text-1', field: 'text', delta: 'partial' } },
    ], {})
    const adapter = new OpenCodeChatAdapter({
      acquireServer: async () => ({ url: 'http://fake', release: async () => undefined }),
      createClient: () => client as never,
    })

    await expect(adapter.start({
      chatId: 'chat-oc', provider: 'opencode', message: 'go', workingDirectory: '/tmp',
      config: { effort: 'medium', fastMode: false },
    })).rejects.toThrow('SSE 在 turn 完成前断开')
  })

  it('中断调用原生 abort，运行态 Tool 详情优先从内存读取', async () => {
    const abort = jest.fn(async () => ({ data: true }))
    let releaseEvents!: () => void
    let resolveTool!: () => void
    const gate = new Promise<void>((resolve) => { releaseEvents = resolve })
    const toolSeen = new Promise<void>((resolve) => { resolveTool = resolve })
    const client = fakeClient([
      { type: 'message.part.updated', data: { sessionID: 'oc-1', part: { id: 'tool-live', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'pwd' } } } } },
      { wait: gate },
      { type: 'session.idle', data: { sessionID: 'oc-1' } },
    ], { abort })
    const adapter = new OpenCodeChatAdapter({
      acquireServer: async () => ({ url: 'http://fake', release: async () => undefined }),
      createClient: () => client as never,
    })
    const turn = adapter.start({
      chatId: 'chat-oc', provider: 'opencode', message: 'go', workingDirectory: '/tmp',
      config: { effort: 'medium', fastMode: false },
      onEvent: (event) => { if (event.type === 'tool_activity') resolveTool() },
    })
    await toolSeen

    const page = await adapter.readToolItem({
      nativeSessionId: 'oc-1', itemId: 'tool-live', cursor: 0, limit: 10_000,
    })
    await adapter.interrupt()
    releaseEvents()
    await turn

    expect(page.available).toBe(true)
    expect(page.content).toContain('pwd')
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'oc-1' }))
  })

  it('归档、恢复与删除直接同步 OpenCode 原生 Session', async () => {
    const update = jest.fn(async () => ({ data: true }))
    const deleteSession = jest.fn(async () => ({ data: true }))
    const client = fakeClient([], { update, deleteSession })
    const adapter = new OpenCodeChatAdapter({
      acquireServer: async () => ({ url: 'http://fake', release: async () => undefined }),
      createClient: () => client as never,
    })

    await adapter.archive('oc-life')
    await adapter.unarchive('oc-life')
    await adapter.delete('oc-life')

    expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionID: 'oc-life', time: { archived: expect.any(Number) },
    }))
    expect(update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionID: 'oc-life', time: { archived: 0 },
    }))
    expect(deleteSession).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'oc-life' }))
  })
})

function fakeClient(
  events: Array<Record<string, unknown>>,
  callbacks: {
    permissionReply?: (value: unknown) => Promise<unknown>
    questionReply?: (value: unknown) => Promise<unknown>
    create?: (value: unknown) => Promise<unknown>
    promptAsync?: (value: unknown) => Promise<unknown>
    abort?: (value: unknown) => Promise<unknown>
    update?: (value: unknown) => Promise<unknown>
    deleteSession?: (value: unknown) => Promise<unknown>
  },
) {
  return {
    session: {
      create: callbacks.create ?? (async () => ({ data: { id: 'oc-1' } })),
      promptAsync: callbacks.promptAsync ?? (async () => ({ data: true })),
      abort: callbacks.abort ?? (async () => ({ data: true })),
      messages: async () => ({ data: [] }),
      update: callbacks.update ?? (async () => ({ data: true })),
      delete: callbacks.deleteSession ?? (async () => ({ data: true })),
    },
    permission: { reply: callbacks.permissionReply ?? (async () => ({ data: true })) },
    question: {
      reply: callbacks.questionReply ?? (async () => ({ data: true })),
      reject: async () => ({ data: true }),
    },
    global: {
      event: async () => ({
        stream: (async function* () {
          await new Promise((resolve) => setImmediate(resolve))
          for (const event of events) {
            if ('wait' in event && event.wait instanceof Promise) await event.wait
            else yield event
          }
        })(),
      }),
    },
  }
}
