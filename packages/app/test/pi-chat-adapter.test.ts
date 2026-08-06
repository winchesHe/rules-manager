import { PassThrough } from 'node:stream'
import { describe, expect, it } from '@jest/globals'
import { PiChatAdapter, type PiProcess } from '../main/pi-chat-adapter.js'
import type { NativeChatEvent } from '../main/chat-runtime.js'

describe('PiChatAdapter', () => {
  it('按 Paseo JSONL RPC 协议发送配置、流式事件并保存 session file', async () => {
    const launched: string[][] = []
    const frames: Array<Record<string, unknown>> = []
    const adapter = new PiChatAdapter((args) => {
      launched.push(args)
      return fakePiProcess(frames)
    })
    const events: NativeChatEvent[] = []
    const result = await adapter.start({
      chatId: 'chat-pi', provider: 'pi', message: 'go', workingDirectory: '/tmp',
      config: { model: 'anthropic/claude-test', effort: 'medium', fastMode: false, thinkingOptionId: 'high' },
      onEvent: (event) => events.push(event),
    })

    expect(launched).toEqual([['--mode', 'rpc']])
    expect(frames.map((frame) => frame.type)).toEqual(expect.arrayContaining([
      'get_state', 'set_model', 'set_thinking_level', 'prompt', 'get_session_stats',
    ]))
    expect(result).toMatchObject({
      nativeSessionId: 'pi-1',
      nativeSessionHandle: { sessionId: 'pi-1', nativeHandle: '/tmp/pi-1.jsonl' },
      content: 'hello', contextUsage: { usedTokens: 5, maxTokens: 100 },
    })
    expect(events).toContainEqual({ type: 'thinking_delta', itemId: 'pi-thinking', text: 'hmm' })
  })

  it('恢复时必须使用 session file，extension_ui_request 可回传且删除不碰原生文件', async () => {
    const launched: string[][] = []
    const frames: Array<Record<string, unknown>> = []
    const adapter = new PiChatAdapter((args) => {
      launched.push(args)
      return fakePiProcess(frames, true)
    })
    const events: NativeChatEvent[] = []
    const resultPromise = adapter.resume({
      chatId: 'chat-pi', provider: 'pi', nativeSessionId: 'pi-1',
      nativeSessionHandle: { sessionId: 'pi-1', nativeHandle: '/tmp/pi-1.jsonl' },
      message: 'resume', workingDirectory: '/tmp',
      config: { effort: 'medium', fastMode: false }, onEvent: (event) => events.push(event),
    })
    await new Promise((resolve) => setImmediate(resolve))
    await adapter.respondToInteraction({ requestId: 'ui-1', answers: { value: ['yes'] } })
    await resultPromise
    await adapter.delete('pi-1')

    expect(launched[0]).toEqual(['--mode', 'rpc', '--session', '/tmp/pi-1.jsonl'])
    expect(events.filter((event) => event.type === 'interaction_request')).toHaveLength(1)
    expect(frames).toContainEqual(expect.objectContaining({
      type: 'extension_ui_response', id: 'ui-1', value: 'yes',
    }))
  })

  it('读取工具历史时用持久化的 session file 恢复原生会话', async () => {
    const launched: string[][] = []
    const adapter = new PiChatAdapter((args) => {
      launched.push(args)
      return fakePiProcess([])
    })

    await adapter.readToolItem({
      nativeSessionId: 'pi-1',
      nativeSessionHandle: { sessionId: 'pi-1', nativeHandle: '/tmp/pi-1.jsonl' },
      itemId: 'tool-1', cursor: 0, limit: 1024,
    })

    expect(launched).toEqual([['--mode', 'rpc', '--session', '/tmp/pi-1.jsonl']])
  })

  it('中断会拒绝当前 turn 并终止 RPC 进程', async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = []
    const adapter = new PiChatAdapter(() => fakeHangingPiProcess(signals))
    const turn = adapter.start({
      chatId: 'chat-pi', provider: 'pi', message: 'wait', workingDirectory: '/tmp',
      config: { effort: 'medium', fastMode: false },
    })
    const interrupted = expect(turn).rejects.toThrow('Pi turn interrupted')
    await new Promise((resolve) => setImmediate(resolve))

    await adapter.interrupt()

    await interrupted
    expect(signals).toContain('SIGTERM')
  })
})

function fakePiProcess(
  frames: Array<Record<string, unknown>>,
  interactive = false,
): PiProcess {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  stdin.setEncoding('utf8')
  let buffer = ''
  stdin.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      const frame = JSON.parse(line) as Record<string, unknown>
      frames.push(frame)
      if (frame.type === 'extension_ui_response') continue
      const data = frame.type === 'get_state'
        ? { sessionId: 'pi-1', sessionFile: '/tmp/pi-1.jsonl' }
        : frame.type === 'get_session_stats'
          ? { contextUsage: { tokens: 5, contextWindow: 100 } }
          : {}
      stdout.write(`${JSON.stringify({ id: frame.id, type: 'response', success: true, data })}\n`)
      if (frame.type === 'prompt') {
        queueMicrotask(() => {
          if (interactive) {
            stdout.write(`${JSON.stringify({ type: 'extension_ui_request', id: 'notice-1', method: 'notify', message: 'Working' })}\n`)
            stdout.write(`${JSON.stringify({ type: 'extension_ui_request', id: 'ui-1', method: 'input', message: 'Continue?' })}\n`)
          }
          stdout.write(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } })}\n`)
          stdout.write(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })}\n`)
          stdout.write(`${JSON.stringify({ type: 'agent_end' })}\n`)
        })
      }
    }
  })
  return {
    stdin, stdout, stderr,
    kill: () => true,
    on(event, listener) {
      if (event === 'exit') exitListeners.push(listener)
      return this
    },
  }
}

function fakeHangingPiProcess(
  signals: Array<NodeJS.Signals | number | undefined>,
): PiProcess {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  stdin.setEncoding('utf8')
  let buffer = ''
  stdin.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      const frame = JSON.parse(line) as Record<string, unknown>
      stdout.write(`${JSON.stringify({
        id: frame.id,
        type: 'response',
        success: true,
        data: frame.type === 'get_state'
          ? { sessionId: 'pi-1', sessionFile: '/tmp/pi-1.jsonl' }
          : {},
      })}\n`)
    }
  })
  return {
    stdin, stdout, stderr,
    kill: (signal) => {
      signals.push(signal)
      return true
    },
    on() { return this },
  }
}
