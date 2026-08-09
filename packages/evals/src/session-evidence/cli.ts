import { runSessionEvidenceEval } from './runner.js'
import type { EvalVariant } from './types.js'
import { EVAL_VARIANTS } from './variants.js'

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const variant = (valueAfter('--variant') ?? 'v3-map-reduce') as EvalVariant
const reporter = valueAfter('--reporter') ?? 'none'
if (!EVAL_VARIANTS.includes(variant)) throw new Error(`unsupported variant: ${variant}`)
if (reporter !== 'none') throw new Error(`unsupported reporter: ${reporter}`)
const run = runSessionEvidenceEval(variant)
console.log(`variant=${run.variant} reporter=${reporter} cases=${run.results.length} case_hashes=stable hard_gates=${run.hardGatesPassed ? 'pass' : 'fail'}`)
if (!run.hardGatesPassed) process.exitCode = 1
