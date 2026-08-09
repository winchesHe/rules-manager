import type { SessionEvidenceEvalReport } from '../types.js'

export interface ReporterResult {
  reporter: 'none' | 'langfuse'
  status: 'skipped' | 'reported'
  runId?: string
  url?: string
}

export interface EvalReporter {
  readonly name: ReporterResult['reporter']
  report(report: SessionEvidenceEvalReport): Promise<ReporterResult>
}

export class NoneReporter implements EvalReporter {
  readonly name = 'none' as const

  async report(_report: SessionEvidenceEvalReport): Promise<ReporterResult> {
    return { reporter: this.name, status: 'skipped' }
  }
}
