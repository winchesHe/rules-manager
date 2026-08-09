import { describe, expect, it } from '@jest/globals'
import {
  createCoverageState,
  finalizeCoverage,
  recordProcessingOutcome,
  recordSourceOutcome,
} from '../../src/evidence-coverage.js'

describe('Session Evidence Coverage', () => {
  it('让单个 JSONL Session 从 selected 进入 readable、processed 和 complete', () => {
    const selected = [{ agent: 'codex' as const, id: 'codex-1' }]
    const initial = createCoverageState('run-1', 'complete', selected)
    const read = recordSourceOutcome(initial, {
      ...selected[0],
      status: 'readable',
      messageCount: 4,
      sourceRevision: {
        kind: 'jsonl-watermark',
        fingerprint: 'sha256:abc',
        changedDuringRun: false,
      },
    })
    const processed = recordProcessingOutcome(read, {
      ...selected[0],
      status: 'processed',
      relevant: true,
    })

    expect(finalizeCoverage(processed)).toEqual({
      runId: 'run-1',
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
        sessionId: 'codex-1',
        agent: 'codex',
        selected: true,
        visited: true,
        sourceStatus: 'readable',
        processingStatus: 'processed',
        relevant: true,
        messageCount: 4,
        sourceRevision: {
          kind: 'jsonl-watermark',
          fingerprint: 'sha256:abc',
          changedDuringRun: false,
        },
      }],
    })
  })

  it('把 empty、unavailable 和 read failure 计入唯一源终态', () => {
    const selected = [
      { agent: 'claude' as const, id: 'empty' },
      { agent: 'cursor' as const, id: 'missing' },
      { agent: 'opencode' as const, id: 'broken' },
    ]
    let state = createCoverageState('run-2', 'complete', selected)
    state = recordSourceOutcome(state, {
      ...selected[0], status: 'empty', messageCount: 0,
    })
    state = recordSourceOutcome(state, {
      ...selected[1], status: 'unavailable', messageCount: 0,
      errorCode: 'SOURCE_MISSING', errorMessage: 'source is missing',
    })
    state = recordSourceOutcome(state, {
      ...selected[2], status: 'failed', messageCount: 0,
      errorCode: 'SQLITE_READ_ERROR', errorMessage: 'database is malformed',
    })

    expect(finalizeCoverage(state)).toMatchObject({
      status: 'partial',
      selected: 3,
      visited: 3,
      readable: 0,
      empty: 1,
      unavailable: 1,
      readFailed: 1,
      processed: 0,
      processFailed: 0,
    })
  })

  it('complete 模式处理失败时降级为 partial 并保留错误', () => {
    const reference = { agent: 'pi' as const, id: 'pi-1' }
    let state = createCoverageState('run-3', 'complete', [reference])
    state = recordSourceOutcome(state, {
      ...reference, status: 'readable', messageCount: 2,
    })
    state = recordProcessingOutcome(state, {
      ...reference,
      status: 'failed',
      relevant: false,
      errorCode: 'MODEL_OUTPUT_INVALID',
      errorMessage: 'invalid JSON',
    })

    expect(finalizeCoverage(state)).toMatchObject({
      status: 'partial',
      processed: 0,
      processFailed: 1,
      relevant: 0,
      rows: [{
        processingStatus: 'failed',
        errorCode: 'MODEL_OUTPUT_INVALID',
        errorMessage: 'invalid JSON',
      }],
    })
  })

  it('targeted 模式允许明确跳过非相关 Session，但不能成为 complete', () => {
    const selected = [
      { agent: 'codex' as const, id: 'hit' },
      { agent: 'codex' as const, id: 'skip' },
    ]
    let state = createCoverageState('run-4', 'targeted', selected)
    for (const reference of selected) {
      state = recordSourceOutcome(state, {
        ...reference, status: 'readable', messageCount: 2,
      })
    }
    state = recordProcessingOutcome(state, {
      ...selected[0], status: 'processed', relevant: true,
    })
    state = recordProcessingOutcome(state, {
      ...selected[1], status: 'not_required', relevant: false,
    })

    expect(finalizeCoverage(state)).toMatchObject({
      mode: 'targeted',
      status: 'targeted',
      readable: 2,
      processed: 1,
      relevant: 1,
    })
  })

  it('拒绝重复 selection、重复源结果和未读取就处理', () => {
    const reference = { agent: 'claude' as const, id: 's1' }
    expect(() => createCoverageState('run-5', 'complete', [reference, reference]))
      .toThrow('selected session references must be unique')

    const initial = createCoverageState('run-5', 'complete', [reference])
    expect(() => recordProcessingOutcome(initial, {
      ...reference, status: 'processed', relevant: false,
    })).toThrow('session source is not readable')

    const read = recordSourceOutcome(initial, {
      ...reference, status: 'empty', messageCount: 0,
    })
    expect(() => recordSourceOutcome(read, {
      ...reference, status: 'empty', messageCount: 0,
    })).toThrow('session source outcome is already recorded')
  })

  it('拒绝在 selected Session 尚未全部访问时完成 Ledger', () => {
    const state = createCoverageState('run-6', 'complete', [
      { agent: 'copilot', id: 'pending' },
    ])

    expect(() => finalizeCoverage(state)).toThrow('coverage has pending source outcomes')
  })
})
