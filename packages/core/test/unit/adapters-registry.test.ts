import { getAdapters, ALL_ADAPTERS } from '../../src/adapters'
import type { AgentName } from '../../src/types'

describe('getAdapters', () => {
  it('已知 agent 列表 → 返回对应 adapter', () => {
    const adapters = getAdapters(['claude', 'codex'])
    expect(adapters.map((a) => a.name)).toEqual(['claude', 'codex'])
  })

  it('未知 agent → 抛错，消息聚合所有未知名 + 列出可用名', () => {
    expect(() => getAdapters(['claude', 'foo', 'bar'] as unknown as AgentName[])).toThrow(
      /Unknown agents?: foo, bar/,
    )
    expect(() => getAdapters(['foo'] as unknown as AgentName[])).toThrow(
      /available: claude, codex, copilot, cursor, gemini, grok, opencode, pi/,
    )
  })

  it('空数组 → 返回空数组', () => {
    expect(getAdapters([])).toEqual([])
  })

  it('ALL_ADAPTERS 涵盖所有 8 个内置 agent', () => {
    expect(ALL_ADAPTERS.map((a) => a.name).sort()).toEqual([
      'claude',
      'codex',
      'copilot',
      'cursor',
      'gemini',
      'grok',
      'opencode',
      'pi',
    ])
  })
})
