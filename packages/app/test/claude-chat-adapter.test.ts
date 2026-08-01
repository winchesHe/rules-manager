import { describe, expect, it } from '@jest/globals'
import {
  ClaudeChatAdapter,
  HOST_SESSION_POLICY,
  type ClaudeQueryFactory,
} from '../main/claude-chat-adapter.js'

describe('ClaudeChatAdapter', () => {
  it('首轮只注入一次 Host Policy，并固定 cwd、持久 Session 与 Full access', async () => {
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = []
    const query: ClaudeQueryFactory = ({ prompt, options }) => {
      calls.push({ prompt, options: options as Record<string, unknown> })
      return (async function* () {
        yield {
          type: 'system', subtype: 'init', session_id: 'claude-session-1',
          cwd: '/workspace', permissionMode: 'bypassPermissions',
        }
        yield { type: 'assistant', session_id: 'claude-session-1', message: {
          content: [{ type: 'text', text: '你好' }],
        } }
        yield { type: 'result', subtype: 'success', session_id: 'claude-session-1', result: '你好' }
      })()
    }
    const adapter = new ClaudeChatAdapter(query)
    const result = await adapter.start({
      chatId: 'chat-1', provider: 'claude', message: 'hi',
      workingDirectory: '/workspace',
      config: { model: 'claude-sonnet', effort: 'high', fastMode: true },
    })

    expect(result).toEqual({ nativeSessionId: 'claude-session-1', content: '你好' })
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
})
