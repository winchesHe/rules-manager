import { describe, expect, it } from '@jest/globals'
import {
  evidenceReferences,
  rulesGenerationCoreBridge,
  runRulesGenerationPreflight,
} from '../main/native-chat-controller.js'

describe('rulesGenerationCoreBridge', () => {
  it('仅把 OpenCode 映射到 Core 编排合同，并保留可审计模型标识', () => {
    expect(rulesGenerationCoreBridge('opencode', undefined)).toEqual({
      provider: 'codex',
      model: 'opencode:default',
    })
    expect(rulesGenerationCoreBridge('opencode', 'openai/gpt-test')).toEqual({
      provider: 'codex',
      model: 'openai/gpt-test',
    })
  })

  it('不允许 Pi 进入 Rules 编排', () => {
    expect(() => rulesGenerationCoreBridge('pi', undefined)).toThrow('Pi 不支持规则生成')
  })

  it('最近 7 天生成先扫描，其他生成范围保持现状', async () => {
    const calls: number[] = []
    const scan = async (sinceDays: number) => {
      calls.push(sinceDays)
      return {
        total: 2, new: 1, updated: 1, unchanged: 0, missing: 0, errors: 0,
        changes: { new: [], updated: [], missing: [] },
      }
    }

    await runRulesGenerationPreflight({ mode: 'changed7d', projects: [] }, scan)
    await runRulesGenerationPreflight({ mode: 'full', projects: [] }, scan)

    expect(calls).toEqual([7])
  })

  it('生成前扫描存在错误时阻止 Provider 生成', async () => {
    await expect(runRulesGenerationPreflight(
      { mode: 'changed7d', projects: [] },
      async () => ({
        total: 1, new: 0, updated: 0, unchanged: 0, missing: 0, errors: 1,
        changes: { new: [], updated: [], missing: [] },
      }),
    )).rejects.toThrow('生成前扫描存在 1 个错误')
  })

  it('Session Context 只保留实际产生 excerpt 的 Session', () => {
    expect(evidenceReferences([{
      projectSlug: 'demo',
      sourceSessions: ['empty-copilot', 'valid-codex'],
      roundCount: 1,
      excerpts: [{
        locator: { sessionId: 'valid-codex', agent: 'codex', messageIndex: 0 },
        role: 'user',
        evidenceKind: 'user_signal',
        text: '必须先扫描',
        tools: [],
        frequency: 1,
      }],
    }])).toEqual([{ id: 'valid-codex', agent: 'codex' }])
    expect(evidenceReferences([{
      projectSlug: 'empty', sourceSessions: ['empty-copilot'], roundCount: 0, excerpts: [],
    }])).toEqual([])
  })
})
