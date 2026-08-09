import { runSessionEvidenceEval } from './runner.js'
import type { EvalVariant } from './types.js'
import { EVAL_VARIANTS } from './variants.js'

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const variant = (valueAfter('--variant') ?? 'v3-map-reduce') as EvalVariant
const reporter = valueAfter('--reporter') ?? 'none'
const output = valueAfter('--output')
if (!EVAL_VARIANTS.includes(variant)) throw new Error(`unsupported variant: ${variant}`)
if (reporter !== 'none') throw new Error(`unsupported reporter: ${reporter}`)
const run = runSessionEvidenceEval(variant)
const report = buildEvalReport(run, loadSessionEvidenceDataset())
if (output) {
  const target = path.resolve(output)
  const temporary = `${target}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, target)
}
console.log(`variant=${run.variant} reporter=${reporter} cases=${run.results.length} case_hashes=stable hard_gates=${run.hardGatesPassed ? 'pass' : 'fail'}${output ? ` report=${path.resolve(output)}` : ''}`)
if (!run.hardGatesPassed) process.exitCode = 1
import fs from 'node:fs'
import path from 'node:path'
import { loadSessionEvidenceDataset } from './dataset.js'
import { buildEvalReport } from './report.js'
