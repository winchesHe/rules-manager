import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
          notify('item/completed', {
            threadId: 'codex-thread-1', item: { id: 'user-1', type: 'userMessage' },
          })
          notify('item/completed', {
            threadId: 'codex-thread-1', item: { id: 'msg-1', type: 'agentMessage' },
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
      if (['thread/archive', 'thread/unarchive', 'thread/delete'].includes(message.method)) {
        respond(message.id, {})
      }
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
      threadId: 'codex-thread-1', model: 'gpt-5.4', effort: 'xhigh', summary: 'auto',
      serviceTier: 'fast', cwd: '/fixed-workspace', approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      input: [{ type: 'text', text: 'hello' }],
    })
    expect(events).toContainEqual({
      type: 'tool_activity',
      activity: {
        itemId: 'cmd-1', kind: 'shell', name: 'Command', status: 'running', summary: 'rtk git status',
        sourceLocator: { turnId: 'codex-turn-1', toolIndex: 0 },
      },
    })
    expect(events).toContainEqual({ type: 'assistant_delta', itemId: 'msg-1', text: 'hello ' })
    expect(JSON.stringify(events)).not.toContain('userMessage')
    expect(JSON.stringify(events)).not.toContain('agentMessage')
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
      .toMatchObject({ serviceTier: null, summary: 'auto' })
  })

  it('把大型文本上下文作为 App Server mention 输入提交', async () => {
    const server = fakeServer()
    const adapter = new CodexChatAdapter(() => server.child)
    await adapter.start({
      chatId: 'chat-mention', provider: 'codex', message: 'read the attachment',
      workingDirectory: '/fixed-workspace',
      config: { effort: 'medium', fastMode: false },
      mentions: [{ name: 'session-context-r1.txt', path: '/tmp/session-context-r1.txt' }],
    })

    expect(server.requests.find((item) => item.method === 'turn/start')?.params)
      .toMatchObject({
        input: [
          { type: 'text', text: 'read the attachment', text_elements: [] },
          { type: 'mention', name: 'session-context-r1.txt', path: '/tmp/session-context-r1.txt' },
        ],
      })
  })

  it('Rules turn 把 outputSchema 交给原生 turn/start', async () => {
    const server = fakeServer()
    const adapter = new CodexChatAdapter(() => server.child)
    const schema = { type: 'array', items: { type: 'object' } }
    await adapter.start({
      chatId: 'rules-chat', provider: 'codex', message: 'generate',
      workingDirectory: '/fixed-workspace',
      config: { effort: 'high', fastMode: false }, outputSchema: schema,
    })
    expect(server.requests.find((item) => item.method === 'turn/start')?.params)
      .toMatchObject({ outputSchema: schema })
  })

  it('为多段 Assistant 与明确 Reasoning 保留稳定 Item ID 和源事件顺序', async () => {
    const server = fakeServer(false)
    const adapter = new CodexChatAdapter(() => server.child)
    const events: Array<{ type: string; itemId?: string }> = []
    const pending = adapter.start({
      chatId: 'chat-order', provider: 'codex', message: 'inspect',
      workingDirectory: '/fixed-workspace', config: { effort: 'high', fastMode: false },
      onEvent: (event) => events.push(event),
    })
    while (!server.requests.some((item) => item.method === 'turn/start')) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    await new Promise((resolve) => setImmediate(resolve))
    server.notify('item/agentMessage/delta', {
      threadId: 'codex-thread-1', itemId: 'commentary', delta: '先检查。',
    })
    server.notify('item/started', {
      threadId: 'codex-thread-1', item: { id: 'cmd-order', type: 'commandExecution', command: 'pwd' },
    })
    server.notify('item/reasoning/summaryTextDelta', {
      threadId: 'codex-thread-1', itemId: 'reasoning-1', delta: '继续确认。',
    })
    server.notify('item/completed', {
      threadId: 'codex-thread-1', item: { id: 'reasoning-1', type: 'reasoning' },
    })
    server.notify('item/agentMessage/delta', {
      threadId: 'codex-thread-1', itemId: 'final', delta: '最终结论。',
    })
    server.notify('turn/completed', {
      threadId: 'codex-thread-1', turn: { id: 'codex-turn-1', status: 'completed' },
    })

    await expect(pending).resolves.toMatchObject({ content: '先检查。最终结论。' })
    expect(events.map((event) => `${event.type}:${event.itemId ?? ''}`)).toEqual([
      'assistant_delta:commentary',
      'tool_activity:',
      'thinking_delta:reasoning-1',
      'thinking_delta:reasoning-1',
      'assistant_delta:final',
    ])
  })

  it('Rules turn 从多个 Agent message 中选择最后一个合法结构化结果', async () => {
    const server = fakeServer(false)
    const adapter = new CodexChatAdapter(() => server.child)
    const pending = adapter.start({
      chatId: 'rules-chat', provider: 'codex', message: 'generate',
      workingDirectory: '/fixed-workspace', config: { effort: 'high', fastMode: false },
      outputSchema: { type: 'object' },
    })
    while (!server.requests.some((item) => item.method === 'turn/start')) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    await new Promise((resolve) => setImmediate(resolve))
    server.notify('item/agentMessage/delta', {
      threadId: 'codex-thread-1', itemId: 'commentary', delta: '{"candidates":[{"rule":"draft"}]}',
    })
    server.notify('item/agentMessage/delta', {
      threadId: 'codex-thread-1', itemId: 'final', delta: '{"candidates":[]}',
    })
    server.notify('turn/completed', {
      threadId: 'codex-thread-1', turn: { id: 'codex-turn-1', status: 'completed' },
    })
    await expect(pending).resolves.toMatchObject({ structuredOutput: { candidates: [] } })
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

  it('thread/read 不含 Tool 时按原生 Session locator 读取 JSONL，且兼容旧轮次序号', async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-codex-source-'))
    const nativeSessionId = '019fc244-749d-7080-98a4-1b9772fa3bca'
    const sourceDirectory = path.join(codexHome, 'sessions', '2026', '08', '02')
    fs.mkdirSync(sourceDirectory, { recursive: true })
    fs.writeFileSync(path.join(sourceDirectory, `rollout-${nativeSessionId}.jsonl`), [
      { type: 'session_meta', payload: { id: nativeSessionId } },
      { type: 'turn_context', payload: { turn_id: 'turn-source-1' } },
      { type: 'response_item', payload: {
        type: 'custom_tool_call', id: 'ctc-source-1', call_id: 'call-source-1', name: 'exec',
        input: 'const r = await tools.exec_command({ cmd: "rtk git status" })',
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-source-1' },
      } },
      { type: 'response_item', payload: {
        type: 'custom_tool_call_output', id: 'ctco-source-1', call_id: 'call-source-1',
        output: [{ type: 'input_text', text: 'clean output' }],
      } },
    ].map((record) => JSON.stringify(record)).join('\n'), 'utf8')
    try {
      const server = fakeServer()
      const adapter = new CodexChatAdapter(() => server.child, codexHome)
      const byTurnId = await adapter.readToolItem({
        nativeSessionId, itemId: 'exec-transient', cursor: 0, limit: 65_536,
        sourceLocator: { turnId: 'turn-source-1', toolIndex: 0 },
      })
      expect(byTurnId.available).toBe(true)
      expect(byTurnId.content).toContain('ctc-source-1')
      expect(byTurnId.content).toContain('clean output')

      const byTurnIndex = await adapter.readToolItem({
        nativeSessionId, itemId: 'exec-legacy', cursor: 0, limit: 65_536,
        sourceLocator: { turnIndex: 0, toolIndex: 0 },
      })
      expect(byTurnIndex.content).toBe(byTurnId.content)

      await expect(adapter.readToolItem({
        nativeSessionId, itemId: 'exec-missing', cursor: 0, limit: 65_536,
        sourceLocator: { turnId: 'turn-source-1', toolIndex: 1 },
      })).resolves.toEqual({ available: false, content: '', nextCursor: null })
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it('Archive、Restore 与 Delete 使用 Codex 原生 thread API', async () => {
    const server = fakeServer()
    const adapter = new CodexChatAdapter(() => server.child)
    await adapter.archive('codex-thread-1')
    await adapter.unarchive('codex-thread-1')
    await adapter.delete('codex-thread-1')
    expect(server.requests.slice(-3).map((request) => [request.method, request.params]))
      .toEqual([
        ['thread/archive', { threadId: 'codex-thread-1' }],
        ['thread/unarchive', { threadId: 'codex-thread-1' }],
        ['thread/delete', { threadId: 'codex-thread-1' }],
      ])
  })
})
