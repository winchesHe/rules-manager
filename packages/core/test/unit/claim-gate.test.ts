import {
  applyClaimGate,
  type SessionEvidenceSynthesis,
} from '../../src/live-evidence-engine'
import type { CoverageLedger } from '../../src/evidence-coverage'
import type { SessionCapsule } from '../../src/live-evidence-context'

function coverage(overrides: Partial<CoverageLedger> = {}): CoverageLedger {
  return {
    runId: 'run-gate',
    mode: 'complete',
    status: 'complete',
    selected: 1,
    visited: 1,
    readable: 1,
    empty: 0,
    unavailable: 0,
    readFailed: 0,
    processed: 1,
    processFailed: 0,
    relevant: 1,
    changedDuringRun: 0,
    rows: [{
      sessionId: 'session-1',
      agent: 'codex',
      selected: true,
      visited: true,
      sourceStatus: 'readable',
      processingStatus: 'processed',
      relevant: true,
      messageCount: 3,
      sourceRevision: {
        kind: 'jsonl-watermark',
        fingerprint: 'revision-1',
        changedDuringRun: false,
      },
    }],
    ...overrides,
  }
}

function capsule(overrides: Partial<SessionCapsule> = {}): SessionCapsule {
  return {
    sessionId: 'session-1',
    agent: 'codex',
    chunkIndex: 0,
    chunkCount: 1,
    summary: 'summary',
    facts: [{
      id: 'fact-1',
      text: '明确事实',
      kind: 'explicit',
      locators: [{
        sessionId: 'session-1',
        agent: 'codex',
        messageIndex: 1,
        sourceRevision: 'revision-1',
      }],
    }],
    relevant: true,
    ...overrides,
  }
}

function synthesis(overrides: Partial<SessionEvidenceSynthesis> = {}): SessionEvidenceSynthesis {
  return {
    answerMarkdown: '基于证据得到结论。',
    claims: [{ text: '结论', evidenceFactIds: ['fact-1'] }],
    limitations: [],
    ...overrides,
  }
}

describe('Live Evidence Claim Gate', () => {
  it('完整 Coverage 下允许可回溯的 fact 与 locator', () => {
    expect(applyClaimGate(synthesis(), [capsule()], coverage())).toMatchObject({
      allowed: true,
      coverageStatus: 'complete',
      violations: [],
      renderedAnswer: '基于证据得到结论。',
    })
  })

  it.each([
    {
      name: 'claim 引用不存在 fact',
      capsules: [capsule()],
      value: synthesis({ claims: [{ text: '结论', evidenceFactIds: ['missing'] }] }),
    },
    {
      name: 'claim 没有 fact 引用',
      capsules: [capsule()],
      value: synthesis({ claims: [{ text: '结论', evidenceFactIds: [] }] }),
    },
    {
      name: 'locator 不属于 Capsule Session',
      capsules: [capsule({ facts: [{
        id: 'fact-1', text: 'fact', kind: 'explicit',
        locators: [{
          sessionId: 'session-2', agent: 'codex', messageIndex: 0, sourceRevision: 'revision-1',
        }],
      }] })],
      value: synthesis(),
    },
    {
      name: 'locator revision 不匹配',
      capsules: [capsule({ facts: [{
        id: 'fact-1', text: 'fact', kind: 'explicit',
        locators: [{
          sessionId: 'session-1', agent: 'codex', messageIndex: 0, sourceRevision: 'wrong',
        }],
      }] })],
      value: synthesis(),
    },
    {
      name: 'locator messageIndex 越界',
      capsules: [capsule({ facts: [{
        id: 'fact-1', text: 'fact', kind: 'explicit',
        locators: [{
          sessionId: 'session-1', agent: 'codex', messageIndex: 3, sourceRevision: 'revision-1',
        }],
      }] })],
      value: synthesis(),
    },
    {
      name: 'inferred fact 没有两个独立 locator',
      capsules: [capsule({ facts: [{
        id: 'fact-1', text: 'fact', kind: 'inferred',
        locators: [{
          sessionId: 'session-1', agent: 'codex', messageIndex: 0, sourceRevision: 'revision-1',
        }],
      }] })],
      value: synthesis(),
    },
    {
      name: 'fact ID 重复',
      capsules: [capsule(), capsule({ chunkIndex: 1, chunkCount: 2 })],
      value: synthesis(),
    },
  ])('$name 时拒绝展示原总结', ({ capsules, value }) => {
    const result = applyClaimGate(value, capsules, coverage())
    expect(result).toMatchObject({
      allowed: false,
      violations: expect.arrayContaining(['unknown-evidence-ref']),
      renderedAnswer: '证据声明校验失败，无法安全展示本轮总结。',
    })
  })

  it('partial 拒绝虚假完整声明，并要求非空 limitations', () => {
    const partial = coverage({
      status: 'partial', selected: 2, visited: 2, unavailable: 1,
    })
    const result = applyClaimGate(synthesis({
      answerMarkdown: '已经总结了所有会话，没有遗漏。',
      limitations: [''],
    }), [capsule()], partial)

    expect(result.allowed).toBe(false)
    expect(result.violations).toEqual(expect.arrayContaining([
      'false-complete-claim', 'missing-limitations',
    ]))
    expect(result.renderedAnswer).not.toContain('没有遗漏')
  })

  it('partial 显示失败计数和脱敏限制，secret 原文不进入可见回答', () => {
    const partial = coverage({
      status: 'partial', selected: 2, visited: 2, unavailable: 1,
    })
    const result = applyClaimGate(synthesis({
      answerMarkdown: '可用证据支持这个结论，token=secret-value。',
      limitations: ['另一个来源 Bearer private-token 不可用'],
    }), [capsule()], partial)

    expect(result.allowed).toBe(false)
    expect(result.violations).toContain('secret-leak')
    expect(result.renderedAnswer).toContain('1 个来源不可用')
    expect(result.renderedAnswer).toContain('[REDACTED]')
    expect(result.renderedAnswer).not.toContain('secret-value')
    expect(result.renderedAnswer).not.toContain('private-token')
  })

  it('targeted 与 changedDuringRun 都使用明确的范围声明', () => {
    const targeted = coverage({
      mode: 'targeted', status: 'targeted', changedDuringRun: 1,
    })
    const result = applyClaimGate(synthesis(), [capsule()], targeted)

    expect(result.allowed).toBe(true)
    expect(result.renderedAnswer).toContain('仅基于本次处理的证据')
    expect(result.renderedAnswer).toContain('1 个来源在读取期间发生变化')
    expect(result.renderedAnswer).toContain('固定读取水位')
  })

  it('failed 不展示模型生成的自然语言结论', () => {
    const failed = coverage({
      status: 'failed', selected: 1, readable: 0, unavailable: 1,
      processed: 0, relevant: 0,
      rows: [{
        ...coverage().rows[0],
        sourceStatus: 'unavailable',
        processingStatus: 'not_required',
        relevant: false,
        messageCount: 0,
        sourceRevision: undefined,
      }],
    })
    const result = applyClaimGate(synthesis({
      answerMarkdown: '模型猜测的结论',
      claims: [],
      limitations: ['没有可用来源'],
    }), [], failed)

    expect(result.allowed).toBe(true)
    expect(result.renderedAnswer).toBe('本轮未能读取或处理可用证据，无法生成可靠总结。')
  })
})
