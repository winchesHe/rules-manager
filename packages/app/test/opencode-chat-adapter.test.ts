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
})

function fakeClient(
  events: Array<Record<string, unknown>>,
  callbacks: {
    permissionReply?: (value: unknown) => Promise<unknown>
    questionReply?: (value: unknown) => Promise<unknown>
  },
) {
  return {
    session: {
      create: async () => ({ data: { id: 'oc-1' } }),
      promptAsync: async () => ({ data: true }),
      abort: async () => ({ data: true }),
      messages: async () => ({ data: [] }),
      update: async () => ({ data: true }),
      delete: async () => ({ data: true }),
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
          for (const event of events) yield event
        })(),
      }),
    },
  }
}
