import fs from 'node:fs'
import path from 'node:path'
import { compareSessionEvidenceVariants } from './comparison.js'
import { loadSessionEvidenceDataset } from './dataset.js'
import { buildEvalReport } from './report.js'
import { runNamedReporter, type ReporterName } from './reporters/reporter-factory.js'
import { runSessionEvidenceEval } from './runner.js'
import type { EvalVariant } from './types.js'
import { EVAL_VARIANTS } from './variants.js'

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function writeJson(targetValue: string, value: unknown): string {
  const target = path.resolve(targetValue)
  const temporary = `${target}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, target)
  return target
}

const variant = (valueAfter('--variant') ?? 'v3-map-reduce') as EvalVariant
const reporter = (valueAfter('--reporter') ?? 'none') as ReporterName
const output = valueAfter('--output')
const compare = process.argv.includes('--compare')
if (!compare && !EVAL_VARIANTS.includes(variant)) throw new Error(`unsupported variant: ${variant}`)
if (reporter !== 'none' && reporter !== 'langfuse') throw new Error(`unsupported reporter: ${reporter}`)
if (compare && reporter !== 'none') throw new Error('Langfuse Reporter 需要指定单一 --variant')

if (compare) {
  const comparison = compareSessionEvidenceVariants()
  const reportPath = output ? writeJson(output, comparison) : undefined
  console.log(`compare=v0-v3 reporter=${reporter} cases=${comparison.variants['v3-map-reduce'].cases.length} dataset=${comparison.datasetMatched ? 'match' : 'mismatch'} v3_thresholds=${comparison.v3ThresholdsPassed ? 'pass' : 'fail'}${reportPath ? ` report=${reportPath}` : ''}`)
  if (!comparison.datasetMatched || !comparison.v3ThresholdsPassed) process.exitCode = 1
} else {
  const run = runSessionEvidenceEval(variant)
  const report = buildEvalReport(run, loadSessionEvidenceDataset())
  const reportPath = output ? writeJson(output, report) : undefined
  const reporterResult = await runNamedReporter(reporter, report)
  const reporterDetail = reporterResult.status === 'reported'
    ? ` reporter_run_id=${reporterResult.runId}${reporterResult.url ? ` reporter_url=${reporterResult.url}` : ''}`
    : reporterResult.status === 'failed' ? ` reporter_failed=${reporterResult.error}` : ''
  console.log(`variant=${run.variant} reporter=${reporter} cases=${run.results.length} case_hashes=stable hard_gates=${run.hardGatesPassed ? 'pass' : 'fail'}${reportPath ? ` report=${reportPath}` : ''}${reporterDetail}`)
  if (!run.hardGatesPassed) process.exitCode = 1
  else if (reporterResult.status === 'failed') process.exitCode = 2
}
