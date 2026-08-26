import type { SessionEvidenceEvalReport } from '../types.js'
import type { EvalReporter, ReporterResult } from './reporter.js'

export interface LangfusePublisher {
  publish(report: SessionEvidenceEvalReport): Promise<{ runId: string; url?: string }>
}

export class LangfuseReporter implements EvalReporter {
  readonly name = 'langfuse' as const

  constructor(private readonly publisher: LangfusePublisher) {}

  async report(report: SessionEvidenceEvalReport): Promise<ReporterResult> {
    const published = await this.publisher.publish(report)
    return {
      reporter: this.name,
      status: 'reported',
      runId: published.runId,
      ...(published.url ? { url: published.url } : {}),
    }
  }
}
