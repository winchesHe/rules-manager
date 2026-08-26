import { loadSessionEvidenceDataset } from './dataset.js'
import type { EvalVariant, VariantCaseResult } from './types.js'
import { runVariant } from './variants.js'
import { evaluateCase } from './evaluator.js'
import type { CaseEvaluation } from './types.js'

export interface EvalRun {
  variant: EvalVariant
  datasetVersion: string
  results: VariantCaseResult[]
  evaluations: CaseEvaluation[]
  hardGatesPassed: boolean
}

export function runSessionEvidenceEval(variant: EvalVariant): EvalRun {
  const cases = loadSessionEvidenceDataset()
  const results = cases.map((testCase) => runVariant(variant, testCase))
  const evaluations = cases.map((testCase, index) => evaluateCase(testCase, results[index]))
  return {
    variant,
    datasetVersion: 'session-evidence-v1',
    results,
    evaluations,
    hardGatesPassed: evaluations.every((evaluation) => evaluation.hardGatesPassed),
  }
}
