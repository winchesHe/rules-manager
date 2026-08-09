import { describe, expect, it } from '@jest/globals'
import {
  ClaudeChatAdapter,
  HOST_SESSION_POLICY,
  type ClaudeQueryFactory,
} from '../main/claude-chat-adapter.js'

describe('ClaudeChatAdapter', () => {
  it('首轮只注入一次 Host Policy，并固定 cwd、持久 Session 与 Full access', async () => {
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = []
    const events: unknown[] = []
    const query: ClaudeQueryFactory = ({ prompt, options }) => {
      calls.push({ prompt, options: options as Record<string, unknown> })
      return (async function* () {
        yield {
          type: 'system', subtype: 'init', session_id: 'claude-session-1',
          cwd: '/workspace', permissionMode: 'bypassPermissions',
        }
        yield { type: 'stream_event', session_id: 'claude-session-1', event: {
          type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: {
            file_path: '/workspace/README.md', secret: 'must-not-leak',
          } },
        } }
        yield { type: 'stream_event', session_id: 'claude-session-1', event: {
          type: 'content_block_delta', index: 1,
          delta: { type: 'text_delta', text: '你' },
        } }
        yield { type: 'assistant', session_id: 'claude-session-1', message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: {
              file_path: '/workspace/README.md', secret: 'must-not-leak',
            } },
            { type: 'text', text: '你好' },
          ],
        } }
        yield {
          type: 'result', subtype: 'success', session_id: 'claude-session-1', result: '你好',
          modelUsage: {
            'claude-sonnet': {
              inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30,
              cacheCreationInputTokens: 10, contextWindow: 200000,
            },
          },
        }
      })()
    }
    const adapter = new ClaudeChatAdapter(query)
    const result = await adapter.start({
      chatId: 'chat-1', provider: 'claude', message: 'hi',
      workingDirectory: '/workspace',
      config: { model: 'claude-sonnet', effort: 'high', fastMode: true },
      onEvent: (event) => events.push(event),
    })

    expect(result).toEqual({
      nativeSessionId: 'claude-session-1', content: '你好',
      contextUsage: { usedTokens: 160, maxTokens: 200000 },
    })
    expect(calls[0]).toMatchObject({
      prompt: 'hi',
      options: {
        cwd: '/workspace',
        persistSession: true,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        model: 'claude-sonnet',
        effort: 'high',
        settings: { fastMode: true },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: HOST_SESSION_POLICY },
      },
    })
    expect(events).toEqual([
      {
        type: 'tool_activity',
        activity: {
          itemId: 'tool-1', kind: 'read', name: 'Read', status: 'running',
          summary: '/workspace/README.md',
        },
      },
      { type: 'assistant_delta', itemId: 'assistant-1', text: '你' },
      {
        type: 'tool_activity',
        activity: {
          itemId: 'tool-1', kind: 'read', name: 'Read', status: 'completed',
          summary: '/workspace/README.md',
        },
      },
      { type: 'usage', contextUsage: { usedTokens: 160, maxTokens: 200000 } },
    ])
    expect(JSON.stringify(events)).not.toContain('must-not-leak')
  })

  it('后续 turn resume 原 ID，且不重复注入 Host Policy', async () => {
    const calls: Array<Record<string, unknown>> = []
    const query: ClaudeQueryFactory = ({ options }) => {
      calls.push(options as Record<string, unknown>)
      return (async function* () {
        yield { type: 'result', subtype: 'success', session_id: 'claude-session-1', result: 'continued' }
      })()
    }
    const adapter = new ClaudeChatAdapter(query)
    const result = await adapter.resume({
      chatId: 'chat-1', provider: 'claude', nativeSessionId: 'claude-session-1',
      message: 'next', workingDirectory: '/workspace',
      config: { effort: 'low', fastMode: false },
    })

    expect(result.nativeSessionId).toBe('claude-session-1')
    expect(calls[0]).toMatchObject({ resume: 'claude-session-1', cwd: '/workspace' })
    expect(calls[0]).not.toHaveProperty('systemPrompt')
  })

  it('none 工具策略从 Claude 上下文移除全部工具并关闭绕过权限', async () => {
    const calls: Array<Record<string, unknown>> = []
    const adapter = new ClaudeChatAdapter(({ options }) => {
      calls.push(options as Record<string, unknown>)
      return (async function* () {
        yield { type: 'result', subtype: 'success', session_id: 'claude-evidence', result: '{}' }
      })()
    })

    await adapter.start({
      chatId: 'evidence-map', provider: 'claude', message: 'map',
      workingDirectory: '/isolated', config: { effort: 'medium', fastMode: false },
      toolPolicy: 'none',
    })

    expect(calls[0]).toMatchObject({
      tools: [], permissionMode: 'default', allowDangerouslySkipPermissions: false,
    })
  })

  it('按 Content Block 顺序区分 Assistant、Thinking 与 Tool', async () => {
    const events: unknown[] = []
    const adapter = new ClaudeChatAdapter(() => (async function* () {
      yield { type: 'stream_event', session_id: 'claude-order', event: {
        type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: '先检查。' },
      } }
      yield { type: 'stream_event', session_id: 'claude-order', event: {
        type: 'content_block_start', index: 1,
        content_block: { type: 'tool_use', id: 'tool-order', name: 'Read', input: { file_path: 'a.md' } },
      } }
      yield { type: 'stream_event', session_id: 'claude-order', event: {
        type: 'content_block_start', index: 2,
        content_block: { type: 'thinking', thinking: '' },
      } }
      yield { type: 'stream_event', session_id: 'claude-order', event: {
        type: 'content_block_delta', index: 2,
        delta: { type: 'thinking_delta', thinking: '继续确认。' },
      } }
      yield { type: 'stream_event', session_id: 'claude-order', event: {
        type: 'content_block_stop', index: 2,
      } }
      yield { type: 'stream_event', session_id: 'claude-order', event: {
        type: 'content_block_delta', index: 3,
        delta: { type: 'text_delta', text: '最终结论。' },
      } }
      yield { type: 'result', subtype: 'success', session_id: 'claude-order', result: '先检查。最终结论。' }
    })())
    await adapter.start({
      chatId: 'chat-order', provider: 'claude', message: 'inspect', workingDirectory: '/workspace',
      config: { effort: 'high', fastMode: false }, onEvent: (event) => events.push(event),
    })

    expect(events).toEqual([
      { type: 'assistant_delta', itemId: 'assistant-0', text: '先检查。' },
      { type: 'tool_activity', activity: {
        itemId: 'tool-order', kind: 'read', name: 'Read', status: 'running', summary: 'a.md',
      } },
      { type: 'thinking_delta', itemId: 'thinking-2', text: '', status: 'running' },
      { type: 'thinking_delta', itemId: 'thinking-2', text: '继续确认。' },
      {
        type: 'thinking_delta', itemId: 'thinking-2', text: '',
        content: '继续确认。', status: 'completed',
      },
      { type: 'assistant_delta', itemId: 'assistant-3', text: '最终结论。' },
    ])
  })

  it('Rules turn 使用原生 outputFormat 并返回 structured output', async () => {
    const calls: Array<Record<string, unknown>> = []
    const adapter = new ClaudeChatAdapter(({ options }) => {
      calls.push(options as Record<string, unknown>)
      return (async function* () {
        yield {
          type: 'result', subtype: 'success', session_id: 'claude-rules', result: '',
          structured_output: [{ rule_text: '始终先验证' }],
        }
      })()
    })
    const schema = { type: 'array', items: { type: 'object' } }
    const result = await adapter.start({
      chatId: 'rules-chat', provider: 'claude', message: 'generate',
      workingDirectory: '/workspace', config: { effort: 'high', fastMode: false },
      outputSchema: schema,
    })
    expect(calls[0]).toMatchObject({ outputFormat: { type: 'json_schema', schema } })
    expect(result.structuredOutput).toEqual([{ rule_text: '始终先验证' }])
  })

  it('完整 Tool 内容只按 Native Item ID 分页读取', async () => {
    const adapter = new ClaudeChatAdapter(
      () => (async function* () {})(),
      async () => [{
        message: { content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/secret' } },
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'full-output' },
        ] },
      }],
    )
    const first = await adapter.readToolItem({
      nativeSessionId: 'claude-session-1', itemId: 'tool-1', cursor: 0, limit: 20,
    })
    expect(first.available).toBe(true)
    expect(first.content.length).toBeLessThanOrEqual(20)
    expect(first.nextCursor).toBe(20)
  })

  it('Archive/Restore 为应用级 no-op，Delete 调用 Claude 原生 SDK', async () => {
    const deleted: string[] = []
    const adapter = new ClaudeChatAdapter(
      () => (async function* () {})(),
      async () => [],
      async (sessionId) => { deleted.push(sessionId) },
    )
    await adapter.archive('claude-session-1')
    await adapter.unarchive('claude-session-1')
    await adapter.delete('claude-session-1')
    expect(deleted).toEqual(['claude-session-1'])
  })
})
