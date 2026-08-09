import { describe, expect, it } from '@jest/globals'
import { loadSessionEvidenceDataset } from '../src/session-evidence/dataset.js'
import { buildEvalReport } from '../src/session-evidence/report.js'
import { runSessionEvidenceEval } from '../src/session-evidence/runner.js'

describe('Session Evidence JSON report', () => {
  it('分开输出门禁、质量和效率，并覆盖 10/151/500 规模', () => {
    const report = buildEvalReport(
      runSessionEvidenceEval('v3-map-reduce'),
      loadSessionEvidenceDataset(),
    )

    expect(report).toMatchObject({
      schemaVersion: 1,
      variant: 'v3-map-reduce',
      hardGates: { passed: true },
      summary: {
        qualityMacro: {
          relevantSessionRecall: 1,
          relevantSessionPrecision: 1,
          goldFactRecall: 1,
          evidenceSupportPrecision: 1,
        },
        efficiency: { latencyMs: { p50: expect.any(Number), p95: expect.any(Number) } },
      },
    })
    expect(report.cases.map((item) => item.sessionCount)).toEqual([1, 10, 151, 500])
    expect(report.cases.every((item) =>
      Object.values(item.quality).every(Number.isFinite)
      && Object.values(item.efficiency).every(Number.isFinite))).toBe(true)
    expect(JSON.stringify(report)).not.toContain('visibleOutput')
    expect(JSON.stringify(report)).not.toContain('人工脱敏 fixture')
  })

  it('v0 报告保留逐 case 回归，不生成单一总分', () => {
    const report = buildEvalReport(
      runSessionEvidenceEval('v0-prompt-only'),
      loadSessionEvidenceDataset(),
    )
    expect(report.hardGates.passed).toBe(false)
    expect(report.cases.some((item) => item.quality.relevantSessionRecall < 1)).toBe(true)
    expect(report.summary).not.toHaveProperty('score')
  })
})
