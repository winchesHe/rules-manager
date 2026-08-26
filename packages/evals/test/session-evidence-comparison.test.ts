import { describe, expect, it } from '@jest/globals'
import {
  compareSessionEvidenceVariants,
  qualityThresholdViolations,
} from '../src/session-evidence/comparison.js'

describe('Session Evidence baseline comparison', () => {
  it('v0-v3 使用同一 caseHash，v3 通过门禁与最低质量阈值', () => {
    const comparison = compareSessionEvidenceVariants()
    expect(comparison).toMatchObject({
      schemaVersion: 1,
      baselineVersion: 1,
      datasetMatched: true,
      v3ThresholdsPassed: true,
      v3ThresholdViolations: [],
    })
    const expectedHashes = comparison.variants['v3-map-reduce'].cases.map((item) => item.caseHash)
    for (const variant of Object.values(comparison.variants)) {
      expect(variant.cases.map((item) => item.caseHash)).toEqual(expectedHashes)
    }
    expect(comparison.variants['v0-prompt-only'].hardGatesPassed).toBe(false)
    expect(comparison.variants['v3-map-reduce'].hardGatesPassed).toBe(true)
    expect(Object.values(comparison.variants['v3-map-reduce'].qualityDelta).every((value) => value === 0)).toBe(true)
    expect(comparison.variants['v3-map-reduce'].efficiencyDelta).toEqual({
      latencyMs: { p50: 0, p95: 0 },
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      readBytes: 0,
      retries: 0,
    })
  })

  it('任一 v3 质量指标低于阈值时给出具名 violation', () => {
    expect(qualityThresholdViolations({
      relevantSessionRecall: 0.9,
      relevantSessionPrecision: 1,
      goldFactRecall: 1,
      evidenceSupportPrecision: 1,
    }, {
      relevantSessionRecall: 0.95,
      relevantSessionPrecision: 0.95,
      goldFactRecall: 0.95,
      evidenceSupportPrecision: 1,
    })).toEqual(['relevantSessionRecall:0.9<0.95'])
  })
})
