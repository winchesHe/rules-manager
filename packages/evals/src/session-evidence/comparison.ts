import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSessionEvidenceDataset } from './dataset.js'
import { buildEvalReport } from './report.js'
import { runSessionEvidenceEval } from './runner.js'
import type { EvalVariant, QualityMetrics, SessionEvidenceEvalReport } from './types.js'
import { EVAL_VARIANTS } from './variants.js'

interface Baseline {
  baselineVersion: 1
  datasetVersion: string
  caseHashes: Record<string, string>
  v3MinimumQuality: QualityMetrics
  variants: Record<EvalVariant, {
    hardGatesPassed: boolean
    qualityMacro: QualityMetrics
    efficiency: SessionEvidenceEvalReport['summary']['efficiency']
  }>
}

export interface VariantComparison {
  hardGatesPassed: boolean
  qualityMacro: QualityMetrics
  qualityDelta: QualityMetrics
  efficiency: SessionEvidenceEvalReport['summary']['efficiency']
  efficiencyDelta: SessionEvidenceEvalReport['summary']['efficiency']
  cases: Array<{ caseId: string; caseHash: string; hardGatesPassed: boolean }>
}

export interface EvalComparison {
  schemaVersion: 1
  baselineVersion: 1
  datasetVersion: string
  datasetMatched: boolean
  v3ThresholdsPassed: boolean
  v3ThresholdViolations: string[]
  variants: Record<EvalVariant, VariantComparison>
}

function loadBaseline(): Baseline {
  const directory = path.dirname(fileURLToPath(import.meta.url))
  const baselinePath = path.resolve(directory, '../../fixtures/session-evidence/baseline-v1.json')
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Baseline
}

function qualityDelta(current: QualityMetrics, baseline: QualityMetrics): QualityMetrics {
  return {
    relevantSessionRecall: current.relevantSessionRecall - baseline.relevantSessionRecall,
    relevantSessionPrecision: current.relevantSessionPrecision - baseline.relevantSessionPrecision,
    goldFactRecall: current.goldFactRecall - baseline.goldFactRecall,
    evidenceSupportPrecision: current.evidenceSupportPrecision - baseline.evidenceSupportPrecision,
  }
}

function efficiencyDelta(
  current: SessionEvidenceEvalReport['summary']['efficiency'],
  baseline: SessionEvidenceEvalReport['summary']['efficiency'],
): SessionEvidenceEvalReport['summary']['efficiency'] {
  return {
    latencyMs: {
      p50: current.latencyMs.p50 - baseline.latencyMs.p50,
      p95: current.latencyMs.p95 - baseline.latencyMs.p95,
    },
    calls: current.calls - baseline.calls,
    inputTokens: current.inputTokens - baseline.inputTokens,
    outputTokens: current.outputTokens - baseline.outputTokens,
    readBytes: current.readBytes - baseline.readBytes,
    retries: current.retries - baseline.retries,
  }
}

export function qualityThresholdViolations(
  quality: QualityMetrics,
  minimum: QualityMetrics,
): string[] {
  return (Object.keys(minimum) as Array<keyof QualityMetrics>)
    .filter((name) => quality[name] < minimum[name])
    .map((name) => `${name}:${quality[name]}<${minimum[name]}`)
}

export function compareSessionEvidenceVariants(): EvalComparison {
  const baseline = loadBaseline()
  const cases = loadSessionEvidenceDataset()
  const datasetMatched = baseline.datasetVersion === 'session-evidence-v1'
    && cases.every((testCase) => baseline.caseHashes[testCase.caseId] === testCase.caseHash)
    && Object.keys(baseline.caseHashes).length === cases.length
  const variants = Object.fromEntries(EVAL_VARIANTS.map((variant) => {
    const report = buildEvalReport(runSessionEvidenceEval(variant), cases)
    return [variant, {
      hardGatesPassed: report.hardGates.passed,
      qualityMacro: report.summary.qualityMacro,
      qualityDelta: qualityDelta(report.summary.qualityMacro, baseline.variants[variant].qualityMacro),
      efficiency: report.summary.efficiency,
      efficiencyDelta: efficiencyDelta(report.summary.efficiency, baseline.variants[variant].efficiency),
      cases: report.cases.map((item) => ({
        caseId: item.caseId,
        caseHash: item.caseHash,
        hardGatesPassed: item.hardGatesPassed,
      })),
    }]
  })) as Record<EvalVariant, VariantComparison>
  const v3ThresholdViolations = [
    ...(variants['v3-map-reduce'].hardGatesPassed ? [] : ['hard-gates']),
    ...qualityThresholdViolations(
      variants['v3-map-reduce'].qualityMacro,
      baseline.v3MinimumQuality,
    ),
  ]
  return {
    schemaVersion: 1,
    baselineVersion: baseline.baselineVersion,
    datasetVersion: baseline.datasetVersion,
    datasetMatched,
    v3ThresholdsPassed: v3ThresholdViolations.length === 0,
    v3ThresholdViolations,
    variants,
  }
}
