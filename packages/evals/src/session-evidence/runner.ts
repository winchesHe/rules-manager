import { loadSessionEvidenceDataset } from './dataset.js'
import type { EvalVariant, VariantCaseResult } from './types.js'
import { runVariant } from './variants.js'

export interface EvalRun {
  variant: EvalVariant
  datasetVersion: string
  results: VariantCaseResult[]
}

export function runSessionEvidenceEval(variant: EvalVariant): EvalRun {
  const cases = loadSessionEvidenceDataset()
  return {
    variant,
    datasetVersion: 'session-evidence-v1',
    results: cases.map((testCase) => runVariant(variant, testCase)),
  }
}
