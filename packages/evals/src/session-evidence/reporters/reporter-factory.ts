import type { SessionEvidenceEvalReport } from '../types.js'
import { LangfuseReporter, type LangfusePublisher } from './langfuse-reporter.js'
import {
  createLangfuseRuntime,
  LangfuseSdkPublisher,
  langfuseConfigFromEnv,
} from './langfuse-sdk-publisher.js'
import { NoneReporter, type EvalReporter, type ReporterResult } from './reporter.js'

export type ReporterName = 'none' | 'langfuse'

export interface ReporterFailure {
  reporter: ReporterName
  status: 'failed'
  error: string
}

export function createReporter(
  name: ReporterName,
  options: { publisher?: LangfusePublisher; env?: NodeJS.ProcessEnv } = {},
): EvalReporter {
  if (name === 'none') return new NoneReporter()
  const publisher = options.publisher ?? new LangfuseSdkPublisher(
    createLangfuseRuntime(langfuseConfigFromEnv(options.env)),
  )
  return new LangfuseReporter(publisher)
}

export function sanitizeReporterError(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of [env.LANGFUSE_PUBLIC_KEY, env.LANGFUSE_SECRET_KEY]) {
    if (secret) message = message.replaceAll(secret, '[REDACTED]')
  }
  return message
    .replace(/(?:pk|sk)-lf-[a-z0-9_-]+/gi, '[REDACTED]')
    .replace(/((?:authorization|api[-_ ]?key))\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
}

export async function runNamedReporter(
  name: ReporterName,
  report: SessionEvidenceEvalReport,
  options: { publisher?: LangfusePublisher; env?: NodeJS.ProcessEnv } = {},
): Promise<ReporterResult | ReporterFailure> {
  try {
    return await runReporter(createReporter(name, options), report, options.env)
  } catch (error) {
    return {
      reporter: name,
      status: 'failed',
      error: sanitizeReporterError(error, options.env),
    }
  }
}

export async function runReporter(
  reporter: EvalReporter,
  report: SessionEvidenceEvalReport,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReporterResult | ReporterFailure> {
  try {
    return await reporter.report(report)
  } catch (error) {
    return {
      reporter: reporter.name,
      status: 'failed',
      error: sanitizeReporterError(error, env),
    }
  }
}
