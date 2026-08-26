import { describe, expect, it } from '@jest/globals'
import { loadSessionEvidenceDataset } from '../src/session-evidence/dataset.js'
import { buildEvalReport } from '../src/session-evidence/report.js'
import {
  LANGFUSE_PHASES,
  LangfuseSdkPublisher,
  langfuseConfigFromEnv,
  langfuseDatasetPayload,
  type DatasetInput,
  type LangfuseRuntime,
} from '../src/session-evidence/reporters/langfuse-sdk-publisher.js'
import { runSessionEvidenceEval } from '../src/session-evidence/runner.js'

function report() {
  return buildEvalReport(runSessionEvidenceEval('v3-map-reduce'), loadSessionEvidenceDataset())
}

function fakeRuntime(inputOverride?: DatasetInput[]) {
  const datasetItems: Array<{ input: DatasetInput }> = []
  const scores: Array<{ name: string; value: number }> = []
  const calls: string[] = []
  const runtime: LangfuseRuntime = {
    createDataset: async ({ name }) => { calls.push(`dataset:${name}`) },
    createDatasetItem: async (item) => {
      calls.push(`item:${item.input.caseId}`)
      datasetItems.push({ input: item.input })
    },
    getDatasetInputs: async () => (inputOverride ?? datasetItems.map((item) => item.input)) as never,
    runExperiment: async (name, params) => {
      calls.push(`experiment:${name}`)
      for (const item of datasetItems) {
        const output = await params.task(item.input as never)
        scores.push(...params.evaluators.map((evaluator) => evaluator(output)))
      }
      return { experimentId: 'dataset-run-1', datasetRunUrl: 'http://localhost:3000/run/1' }
    },
    shutdown: async () => { calls.push('shutdown') },
  }
  return { runtime, datasetItems, scores, calls }
}

describe('Langfuse SDK Publisher', () => {
  it('映射 Dataset、Experiment、五阶段 Observation 与九项 Score', async () => {
    const fake = fakeRuntime()
    const phases: string[] = []
    const publisher = new LangfuseSdkPublisher(fake.runtime, async (phase) => { phases.push(phase) })

    await expect(publisher.publish(report())).resolves.toEqual({
      runId: 'dataset-run-1', url: 'http://localhost:3000/run/1',
    })

    expect(fake.datasetItems).toHaveLength(4)
    expect(fake.calls).toContain('experiment:memory-manager-session-evidence-v1')
    expect(fake.calls.at(-1)).toBe('shutdown')
    expect(phases).toEqual(Array.from({ length: 4 }, () => LANGFUSE_PHASES).flat())
    expect(fake.scores).toHaveLength(4 * 9)
    expect(new Set(fake.scores.map((score) => score.name))).toEqual(new Set([
      'source_accounting_pass', 'processing_accounting_pass', 'false_complete_claim_pass',
      'locator_validity', 'secret_leak_pass', 'relevantSessionRecall',
      'relevantSessionPrecision', 'goldFactRecall', 'evidenceSupportPrecision',
    ]))
  })

  it('远端 Dataset caseHash 不一致时拒绝实验并仍 shutdown', async () => {
    const fake = fakeRuntime([{ caseId: 'stale', caseHash: 'stale', tags: [], sessionCount: 1 }])
    const publisher = new LangfuseSdkPublisher(fake.runtime)
    await expect(publisher.publish(report())).rejects.toThrow('caseHash 与本地 manifest 不一致')
    expect(fake.calls).not.toContain(expect.stringMatching(/^experiment:/))
    expect(fake.calls.at(-1)).toBe('shutdown')
  })

  it('配置支持本地 base URL，缺少 key 时明确失败', () => {
    expect(langfuseConfigFromEnv({
      LANGFUSE_PUBLIC_KEY: 'pk-local',
      LANGFUSE_SECRET_KEY: 'sk-local',
      LANGFUSE_BASE_URL: 'http://localhost:3000',
    })).toEqual({
      publicKey: 'pk-local', secretKey: 'sk-local', baseUrl: 'http://localhost:3000',
    })
    expect(() => langfuseConfigFromEnv({})).toThrow('缺少 LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY')
  })

  it('Dataset payload 使用字段 allowlist，不包含正文、Prompt 或 Tool output', () => {
    const localReport = report() as ReturnType<typeof report> & Record<string, unknown>
    localReport.requestText = 'DO NOT UPLOAD PROMPT'
    localReport.visibleOutput = 'DO NOT UPLOAD OUTPUT'
    localReport.toolOutput = 'DO NOT UPLOAD TOOL'
    const serialized = JSON.stringify(langfuseDatasetPayload(localReport))
    expect(serialized).not.toContain('DO NOT UPLOAD')
    expect(JSON.parse(serialized)[0]).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      datasetName: 'memory-manager-session-evidence-v1',
      input: {
        caseId: 'single-complete',
        caseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        tags: ['scale-1', 'complete'],
        sessionCount: 1,
      },
      expectedOutput: { caseHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      metadata: {
        caseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        datasetVersion: 'session-evidence-v1',
      },
    })
  })
})
