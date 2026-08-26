import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@jest/globals'
import { loadSessionEvidenceDataset } from '../src/session-evidence/dataset.js'
import { buildEvalReport } from '../src/session-evidence/report.js'
import { LangfuseReporter } from '../src/session-evidence/reporters/langfuse-reporter.js'
import { NoneReporter } from '../src/session-evidence/reporters/reporter.js'
import {
  createReporter,
  runNamedReporter,
  runReporter,
  sanitizeReporterError,
} from '../src/session-evidence/reporters/reporter-factory.js'
import { runSessionEvidenceEval } from '../src/session-evidence/runner.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

describe('Session Evidence reporters', () => {
  const report = buildEvalReport(
    runSessionEvidenceEval('v3-map-reduce'),
    loadSessionEvidenceDataset(),
  )

  it('none reporter 明确跳过且不改变本地报告', async () => {
    await expect(new NoneReporter().report(report)).resolves.toEqual({
      reporter: 'none', status: 'skipped',
    })
  })

  it('Langfuse Reporter 只依赖 Publisher 合同并返回 run id/url', async () => {
    const reporter = new LangfuseReporter({
      publish: async (received) => {
        expect(received).toBe(report)
        return { runId: 'run-local', url: 'http://localhost:3000/run-local' }
      },
    })
    await expect(reporter.report(report)).resolves.toEqual({
      reporter: 'langfuse', status: 'reported', runId: 'run-local',
      url: 'http://localhost:3000/run-local',
    })
  })

  it('Langfuse SDK 依赖只存在于 eval workspace', () => {
    const evalPackage = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'packages/evals/package.json'), 'utf8'))
    const corePackage = fs.readFileSync(path.join(repositoryRoot, 'packages/core/package.json'), 'utf8')
    const appPackage = fs.readFileSync(path.join(repositoryRoot, 'packages/app/package.json'), 'utf8')
    expect(Object.keys(evalPackage.dependencies ?? {})).toEqual(expect.arrayContaining([
      '@langfuse/client', '@langfuse/otel', '@langfuse/tracing', '@opentelemetry/sdk-node',
    ]))
    expect(corePackage).not.toContain('@langfuse/')
    expect(appPackage).not.toContain('@langfuse/')
  })

  it('Reporter 失败不改变本地报告并脱敏错误', async () => {
    const original = structuredClone(report)
    const reporter = createReporter('langfuse', {
      publisher: {
        publish: async () => {
          throw new Error('authorization=sk-lf-test api-key=pk-lf-public-secret')
        },
      },
    })
    await expect(runReporter(reporter, report, {
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_PUBLIC_KEY: 'pk-lf-public-secret',
    })).resolves.toEqual({
      reporter: 'langfuse',
      status: 'failed',
      error: 'authorization=[REDACTED] api-key=[REDACTED]',
    })
    expect(report).toEqual(original)
  })

  it('通用错误脱敏不泄漏 key', () => {
    expect(sanitizeReporterError(new Error('flush pk-lf-abcdef sk-lf-test')))
      .toBe('flush [REDACTED] [REDACTED]')
  })

  it('Factory 配置失败也转换为 reporter_failed', async () => {
    await expect(runNamedReporter('langfuse', report, { env: {} })).resolves.toEqual({
      reporter: 'langfuse',
      status: 'failed',
      error: 'Langfuse Reporter 缺少 LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY',
    })
  })
})
