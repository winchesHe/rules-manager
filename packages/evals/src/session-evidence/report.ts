import type { EvalRun } from './runner.js'
import type {
  EfficiencyMetrics,
  HardGateName,
  QualityMetrics,
  SessionEvidenceEvalCase,
  SessionEvidenceEvalReport,
  VariantCaseResult,
} from './types.js'

const GATE_NAMES: HardGateName[] = [
  'source_accounting_pass',
  'processing_accounting_pass',
  'false_complete_claim_pass',
  'locator_validity',
  'secret_leak_pass',
]

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator
}

function intersectionSize(left: string[], right: string[]): number {
  const expected = new Set(right)
  return new Set(left.filter((value) => expected.has(value))).size
}

export function qualityMetrics(
  testCase: SessionEvidenceEvalCase,
  result: VariantCaseResult,
): QualityMetrics {
  const relevantMatches = intersectionSize(
    result.relevantSessionIds,
    testCase.goldRelevantSessionIds,
  )
  const goldFactIds = testCase.goldFacts.map((fact) => fact.id)
  const factMatches = intersectionSize(result.facts.map((fact) => fact.id), goldFactIds)
  const supportedFacts = result.facts.filter((fact) => {
    const gold = testCase.goldFacts.find((candidate) => candidate.id === fact.id)
    if (!gold || fact.locators.length === 0) return false
    return fact.locators.every((locator) => gold.acceptableLocators.some((candidate) =>
      candidate.sessionId === locator.sessionId
      && candidate.agent === locator.agent
      && candidate.messageIndex === locator.messageIndex))
  }).length
  return {
    relevantSessionRecall: ratio(relevantMatches, testCase.goldRelevantSessionIds.length),
    relevantSessionPrecision: ratio(relevantMatches, new Set(result.relevantSessionIds).size),
    goldFactRecall: ratio(factMatches, goldFactIds.length),
    evidenceSupportPrecision: ratio(supportedFacts, result.facts.length),
  }
}

function efficiencyMetrics(result: VariantCaseResult): EfficiencyMetrics {
  return {
    latencyMs: result.latencyMs,
    calls: result.calls,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    readBytes: result.readBytes,
    retries: result.retries,
  }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]
}

export function buildEvalReport(
  run: EvalRun,
  cases: SessionEvidenceEvalCase[],
): SessionEvidenceEvalReport {
  const byCaseId = new Map(cases.map((testCase) => [testCase.caseId, testCase]))
  const reportCases = run.results.map((result, index) => {
    const testCase = byCaseId.get(result.caseId)
    if (!testCase || testCase.caseHash !== result.caseHash) {
      throw new Error(`eval case hash mismatch: ${result.caseId}`)
    }
    const evaluation = run.evaluations[index]
    return {
      caseId: result.caseId,
      caseHash: result.caseHash,
      tags: [...testCase.tags],
      sessionCount: testCase.selected.length,
      hardGatesPassed: evaluation.hardGatesPassed,
      gates: evaluation.gates,
      quality: qualityMetrics(testCase, result),
      efficiency: efficiencyMetrics(result),
    }
  })
  const qualityMacro = {
    relevantSessionRecall: mean(reportCases.map((item) => item.quality.relevantSessionRecall)),
    relevantSessionPrecision: mean(reportCases.map((item) => item.quality.relevantSessionPrecision)),
    goldFactRecall: mean(reportCases.map((item) => item.quality.goldFactRecall)),
    evidenceSupportPrecision: mean(reportCases.map((item) => item.quality.evidenceSupportPrecision)),
  }
  const byName = Object.fromEntries(GATE_NAMES.map((name) => [
    name,
    reportCases.every((item) => item.gates.find((gate) => gate.name === name)?.passed === true),
  ])) as Record<HardGateName, boolean>
  return {
    schemaVersion: 1,
    datasetVersion: run.datasetVersion,
    variant: run.variant,
    hardGates: { passed: Object.values(byName).every(Boolean), byName },
    cases: reportCases,
    summary: {
      qualityMacro,
      efficiency: {
        latencyMs: {
          p50: percentile(reportCases.map((item) => item.efficiency.latencyMs), 0.5),
          p95: percentile(reportCases.map((item) => item.efficiency.latencyMs), 0.95),
        },
        calls: reportCases.reduce((total, item) => total + item.efficiency.calls, 0),
        inputTokens: reportCases.reduce((total, item) => total + item.efficiency.inputTokens, 0),
        outputTokens: reportCases.reduce((total, item) => total + item.efficiency.outputTokens, 0),
        readBytes: reportCases.reduce((total, item) => total + item.efficiency.readBytes, 0),
        retries: reportCases.reduce((total, item) => total + item.efficiency.retries, 0),
      },
    },
  }
}
