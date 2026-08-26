import { describe, expect, it } from '@jest/globals'
import { loadSessionEvidenceDataset } from '../src/session-evidence/dataset.js'
import { runSessionEvidenceEval } from '../src/session-evidence/runner.js'
import { EVAL_VARIANTS } from '../src/session-evidence/variants.js'

describe('Session Evidence eval runner', () => {
  it('同一 manifest 重复加载得到相同 caseHash', () => {
    const first = loadSessionEvidenceDataset()
    const second = loadSessionEvidenceDataset()
    expect(first.map((item) => item.caseHash)).toEqual(second.map((item) => item.caseHash))
    expect(first.map((item) => item.selected.length)).toEqual([1, 10, 151, 500])
  })

  it.each(EVAL_VARIANTS)('%s 对固定 Dataset 运行并保留 caseHash', (variant) => {
    const run = runSessionEvidenceEval(variant)
    expect(run.results).toHaveLength(4)
    expect(run.results.every((result) => result.variant === variant && result.caseHash.length === 64)).toBe(true)
  })
})
