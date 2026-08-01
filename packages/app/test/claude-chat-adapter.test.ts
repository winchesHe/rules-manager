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
          content: [{ type: 'text', text: '你好' }],
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
      { type: 'assistant_delta', text: '你' },
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
})
