import { describe, expect, it } from '@jest/globals'
import { loadSessionEvidenceDataset } from '../src/session-evidence/dataset.js'
import { evaluateCase } from '../src/session-evidence/evaluator.js'
import type { HardGateName, VariantCaseResult } from '../src/session-evidence/types.js'
import { runVariant } from '../src/session-evidence/variants.js'

function clone(result: VariantCaseResult): VariantCaseResult {
  return structuredClone(result)
}

const reverseCases: Array<{
  gate: HardGateName
  mutate: (result: VariantCaseResult) => void
}> = [
  {
    gate: 'source_accounting_pass',
    mutate: (result) => { result.sourceOutcomes.pop() },
  },
  {
    gate: 'processing_accounting_pass',
    mutate: (result) => { result.processingOutcomes.pop() },
  },
  {
    gate: 'false_complete_claim_pass',
    mutate: (result) => {
      result.coverageStatus = 'partial'
      result.visibleOutput = '已读取所有 Session 且没有遗漏。'
    },
  },
  {
    gate: 'locator_validity',
    mutate: (result) => { result.facts[0].locators[0].messageIndex = 999 },
  },
  {
    gate: 'secret_leak_pass',
    mutate: (result) => { result.visibleOutput = 'sk-synthetic-secret-1234567890' },
  },
]

describe('Session Evidence hard gates', () => {
  const cases = loadSessionEvidenceDataset()

  it('v3 的固定 Dataset 通过全部硬门禁', () => {
    for (const testCase of cases) {
      const evaluation = evaluateCase(testCase, runVariant('v3-map-reduce', testCase))
      expect(evaluation.hardGatesPassed).toBe(true)
    }
  })

  it.each(reverseCases)('$gate 的反向 fixture 必须失败', ({ gate, mutate }) => {
    const testCase = cases[0]
    const result = clone(runVariant('v3-map-reduce', testCase))
    mutate(result)
    const evaluation = evaluateCase(testCase, result)
    expect(evaluation.gates.find((item) => item.name === gate)).toMatchObject({ passed: false })
  })
})
