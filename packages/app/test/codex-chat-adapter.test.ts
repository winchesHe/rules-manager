import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from '@jest/globals'
import {
  CodexChatAdapter,
  type CodexAppServerProcess,
} from '../main/codex-chat-adapter.js'

function fakeServer(autoComplete = true) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: () => true,
  }) as CodexAppServerProcess
  const requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  let buffer = ''
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      const message = JSON.parse(line) as typeof requests[number]
      if (typeof message.id !== 'number') continue
      requests.push(message)
      if (message.method === 'initialize') respond(message.id, {})
      if (message.method === 'thread/start') respond(message.id, { thread: { id: 'codex-thread-1' } })
      if (message.method === 'thread/resume') respond(message.id, { thread: { id: 'codex-thread-1' } })
      if (message.method === 'turn/start') {
        respond(message.id, { turn: { id: 'codex-turn-1' } })
        queueMicrotask(() => {
          notify('turn/started', { threadId: 'codex-thread-1', turn: { id: 'codex-turn-1' } })
          if (!autoComplete) return
          notify('item/started', {
            threadId: 'codex-thread-1',
            item: { id: 'cmd-1', type: 'commandExecution', command: 'rtk git status', rawOutput: 'must-not-leak' },
          })
          notify('item/agentMessage/delta', { threadId: 'codex-thread-1', itemId: 'msg-1', delta: 'hello ' })
          notify('item/agentMessage/delta', { threadId: 'codex-thread-1', itemId: 'msg-1', delta: 'codex' })
          notify('thread/tokenUsage/updated', {
            threadId: 'codex-thread-1',
            tokenUsage: { model_context_window: 200000, last: { total_tokens: 50000 } },
          })
          notify('turn/completed', { threadId: 'codex-thread-1', turn: { id: 'codex-turn-1', status: 'completed', error: null } })
        })
      }
      if (message.method === 'turn/interrupt') respond(message.id, {})
      if (message.method === 'thread/read') respond(message.id, {
        thread: { id: 'codex-thread-1', turns: [{ items: [{
          id: 'cmd-1', type: 'commandExecution', command: 'full-command', aggregatedOutput: 'full-output',
        }] }] },
      })
    }
  })
  function respond(id: number, result: unknown) {
    stdout.write(`${JSON.stringify({ id, result })}\n`)
  }
  function notify(method: string, params: unknown) {
    stdout.write(`${JSON.stringify({ method, params })}\n`)
  }
  return { child, requests, notify }
}

describe('CodexChatAdapter', () => {
  it('使用 app-server 创建 thread 并按轮传递完整配置与权威 usage', async () => {
    const server = fakeServer()
    const adapter = new CodexChatAdapter(() => server.child)
    const events: unknown[] = []
    const result = await adapter.start({
      chatId: 'chat-codex', provider: 'codex', message: 'hello',
      workingDirectory: '/fixed-workspace',
      config: { model: 'gpt-5.4', effort: 'xhigh', fastMode: true },
      onEvent: (event) => events.push(event),
    })

    expect(result).toEqual({
      nativeSessionId: 'codex-thread-1',
      content: 'hello codex',
      contextUsage: { usedTokens: 50000, maxTokens: 200000 },
    })
    expect(server.requests.map((item) => item.method)).toEqual([
      'initialize', 'thread/start', 'turn/start',
    ])
    expect(server.requests.find((item) => item.method === 'thread/start')?.params).toMatchObject({
      model: 'gpt-5.4', cwd: '/fixed-workspace', approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    expect(server.requests.find((item) => item.method === 'turn/start')?.params).toMatchObject({
      threadId: 'codex-thread-1', model: 'gpt-5.4', effort: 'xhigh',
      serviceTier: 'fast', cwd: '/fixed-workspace', approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      input: [{ type: 'text', text: 'hello' }],
    })
    expect(events).toContainEqual({
      type: 'tool_activity',
      activity: {
        itemId: 'cmd-1', kind: 'shell', name: 'Command', status: 'running', summary: 'rtk git status',
      },
    })
    expect(events).toContainEqual({ type: 'assistant_delta', text: 'hello ' })
    expect(events).toContainEqual({
      type: 'usage', contextUsage: { usedTokens: 50000, maxTokens: 200000 },
    })
    expect(JSON.stringify(events)).not.toContain('must-not-leak')
  })

  it('重启后 resume 原 thread，interrupt 使用当前 turn ID', async () => {
    const server = fakeServer()
    const adapter = new CodexChatAdapter(() => server.child)
    await adapter.resume({
      chatId: 'chat-codex', provider: 'codex', nativeSessionId: 'codex-thread-1',
      message: 'continue', workingDirectory: '/fixed-workspace',
      config: { effort: 'medium', fastMode: false },
    })
    expect(server.requests.map((item) => item.method)).toEqual([
      'initialize', 'thread/resume', 'turn/start',
    ])
    expect(server.requests.find((item) => item.method === 'thread/resume')?.params)
      .toEqual({ threadId: 'codex-thread-1' })
    expect(server.requests.find((item) => item.method === 'turn/start')?.params)
      .toMatchObject({ serviceTier: null })
  })

  it('运行中 interrupt 发给 app-server 而不删除 thread', async () => {
    const server = fakeServer(false)
    const adapter = new CodexChatAdapter(() => server.child)
    const running = adapter.start({
      chatId: 'chat-codex', provider: 'codex', message: 'hello',
      workingDirectory: '/fixed-workspace',
      config: { effort: 'high', fastMode: false },
    })
    while (!server.requests.some((item) => item.method === 'turn/start')) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    await new Promise((resolve) => setImmediate(resolve))
    await adapter.interrupt()
    server.notify('turn/completed', {
      threadId: 'codex-thread-1', turn: { id: 'codex-turn-1', status: 'interrupted', error: null },
    })
    await running
    expect(server.requests.find((item) => item.method === 'turn/interrupt')?.params)
      .toEqual({ threadId: 'codex-thread-1', turnId: 'codex-turn-1' })
  })

  it('完整 Tool 内容通过 thread/read 按 Item ID 分页读取', async () => {
    const server = fakeServer()
    const adapter = new CodexChatAdapter(() => server.child)
    const page = await adapter.readToolItem({
      nativeSessionId: 'codex-thread-1', itemId: 'cmd-1', cursor: 0, limit: 24,
    })
    expect(page.available).toBe(true)
    expect(page.content.length).toBeLessThanOrEqual(24)
    expect(page.nextCursor).toBe(24)
    expect(server.requests.map((item) => item.method)).toContain('thread/read')
  })
})
