import { describe, expect, it } from '@jest/globals'
import { validateSessionReferences } from '../main/session-context-validation.js'

describe('validateSessionReferences', () => {
  it('接受超过旧 500 上限的合法 Session 引用', () => {
    const references = Array.from({ length: 1_000 }, (_, index) => ({
      agent: 'codex',
      id: `session-${index}`,
    }))
    expect(validateSessionReferences(references)).toHaveLength(1_000)
  })

  it('放开数量后仍严格校验数组和每条引用', () => {
    expect(() => validateSessionReferences('invalid')).toThrow('must be an array')
    expect(() => validateSessionReferences([{ agent: 'unknown', id: 'session-1' }]))
      .toThrow('agent is unsupported')
    expect(() => validateSessionReferences([{ agent: 'codex', id: '' }]))
      .toThrow('id is required')
  })

  it('接受 Gemini CLI 与 Grok Build 的 Session 引用', () => {
    expect(validateSessionReferences([
      { agent: 'gemini', id: 'gemini-session' },
      { agent: 'grok', id: 'grok-session' },
    ])).toEqual([
      { agent: 'gemini', id: 'gemini-session' },
      { agent: 'grok', id: 'grok-session' },
    ])
  })
})
