import crypto from 'node:crypto'
import { LangfuseClient } from '@langfuse/client'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { startActiveObservation } from '@langfuse/tracing'
import { NodeSDK } from '@opentelemetry/sdk-node'
import type {
  HardGateName,
  QualityMetrics,
  SessionEvidenceEvalReport,
} from '../types.js'
import type { LangfusePublisher } from './langfuse-reporter.js'

export const LANGFUSE_PHASES = ['plan', 'read', 'map', 'reduce', 'gate'] as const

export interface DatasetInput {
  caseId: string
  caseHash: string
  tags: string[]
  sessionCount: number
}

interface ReporterCaseOutput {
  hardGatesPassed: boolean
  gates: Record<HardGateName, boolean>
  quality: QualityMetrics
  efficiency: SessionEvidenceEvalReport['cases'][number]['efficiency']
}

interface LangfuseExperimentParams {
  name: string
  runName: string
  description: string
  metadata: Record<string, unknown>
  task: (input: DatasetInput) => Promise<ReporterCaseOutput>
  evaluators: Array<(output: ReporterCaseOutput) => { name: string; value: number }>
}

export interface LangfuseRuntime {
  createDataset(input: { name: string; description: string; metadata: Record<string, unknown> }): Promise<void>
  createDatasetItem(input: {
    id: string
    datasetName: string
    input: DatasetInput
    expectedOutput: { caseHash: string }
    metadata: { caseHash: string; datasetVersion: string }
  }): Promise<void>
  getDatasetInputs(name: string): Promise<DatasetInput[]>
  runExperiment(name: string, params: LangfuseExperimentParams): Promise<{
    experimentId: string
    datasetRunUrl?: string
  }>
  shutdown(): Promise<void>
}

export interface LangfuseReporterConfig {
  publicKey: string
  secretKey: string
  baseUrl: string
}

type ObservePhase = (
  phase: typeof LANGFUSE_PHASES[number],
  attributes: Record<string, unknown>,
) => Promise<void>

function stableItemId(datasetVersion: string, caseHash: string): string {
  return crypto.createHash('sha256')
    .update(`${datasetVersion}\0${caseHash}`)
    .digest('hex')
}

function datasetInput(reportCase: SessionEvidenceEvalReport['cases'][number]): DatasetInput {
  return {
    caseId: reportCase.caseId,
    caseHash: reportCase.caseHash,
    tags: [...reportCase.tags],
    sessionCount: reportCase.sessionCount,
  }
}

function caseOutput(reportCase: SessionEvidenceEvalReport['cases'][number]): ReporterCaseOutput {
  return {
    hardGatesPassed: reportCase.hardGatesPassed,
    gates: Object.fromEntries(reportCase.gates.map((gate) => [gate.name, gate.passed])) as Record<HardGateName, boolean>,
    quality: { ...reportCase.quality },
    efficiency: { ...reportCase.efficiency },
  }
}

export function langfuseDatasetPayload(report: SessionEvidenceEvalReport): Array<{
  id: string
  datasetName: string
  input: DatasetInput
  expectedOutput: { caseHash: string }
  metadata: { caseHash: string; datasetVersion: string }
}> {
  const datasetName = `memory-manager-${report.datasetVersion}`
  return report.cases.map((reportCase) => ({
    id: stableItemId(report.datasetVersion, reportCase.caseHash),
    datasetName,
    input: datasetInput(reportCase),
    expectedOutput: { caseHash: reportCase.caseHash },
    metadata: { caseHash: reportCase.caseHash, datasetVersion: report.datasetVersion },
  }))
}

function scoreEvaluators(): LangfuseExperimentParams['evaluators'] {
  const gateNames: HardGateName[] = [
    'source_accounting_pass', 'processing_accounting_pass', 'false_complete_claim_pass',
    'locator_validity', 'secret_leak_pass',
  ]
  const qualityNames: Array<keyof QualityMetrics> = [
    'relevantSessionRecall', 'relevantSessionPrecision',
    'goldFactRecall', 'evidenceSupportPrecision',
  ]
  return [
    ...gateNames.map((name) => (output: ReporterCaseOutput) => ({
      name,
      value: output.gates[name] ? 1 : 0,
    })),
    ...qualityNames.map((name) => (output: ReporterCaseOutput) => ({
      name,
      value: output.quality[name],
    })),
  ]
}

async function observePhase(
  phase: typeof LANGFUSE_PHASES[number],
  attributes: Record<string, unknown>,
): Promise<void> {
  await startActiveObservation(`session-evidence.${phase}`, async (span) => {
    span.update({ input: attributes, output: { status: 'completed' } })
  })
}

export class LangfuseSdkPublisher implements LangfusePublisher {
  constructor(
    private readonly runtime: LangfuseRuntime,
    private readonly observe: ObservePhase = observePhase,
  ) {}

  async publish(report: SessionEvidenceEvalReport): Promise<{ runId: string; url?: string }> {
    const datasetName = `memory-manager-${report.datasetVersion}`
    try {
      await this.runtime.createDataset({
        name: datasetName,
        description: 'Memory Manager Session Evidence 固定脱敏评测集',
        metadata: { datasetVersion: report.datasetVersion, schemaVersion: report.schemaVersion },
      })
      const payload = langfuseDatasetPayload(report)
      for (const item of payload) await this.runtime.createDatasetItem(item)
      const remoteInputs = await this.runtime.getDatasetInputs(datasetName)
      const localHashes = payload.map((item) => item.input.caseHash).sort()
      const remoteHashes = remoteInputs.map((input) => input.caseHash).sort()
      if (JSON.stringify(localHashes) !== JSON.stringify(remoteHashes)) {
        throw new Error('Langfuse Dataset caseHash 与本地 manifest 不一致')
      }
      const byCaseId = new Map(report.cases.map((reportCase) => [reportCase.caseId, reportCase]))
      const experiment = await this.runtime.runExperiment(datasetName, {
        name: `session-evidence-${report.variant}`,
        runName: `${report.variant}-${Date.now()}`,
        description: `Session Evidence ${report.variant} 固定基线评测`,
        metadata: {
          datasetVersion: report.datasetVersion,
          variant: report.variant,
          schemaVersion: report.schemaVersion,
        },
        task: async (input) => {
          const reportCase = byCaseId.get(input.caseId)
          if (!reportCase || reportCase.caseHash !== input.caseHash) {
            throw new Error(`Langfuse Dataset Item 不匹配：${input.caseId}`)
          }
          for (const phase of LANGFUSE_PHASES) {
            await this.observe(phase, {
              caseId: input.caseId,
              caseHash: input.caseHash,
              variant: report.variant,
              sessionCount: input.sessionCount,
            })
          }
          return caseOutput(reportCase)
        },
        evaluators: scoreEvaluators(),
      })
      return {
        runId: experiment.experimentId,
        ...(experiment.datasetRunUrl ? { url: experiment.datasetRunUrl } : {}),
      }
    } finally {
      await this.runtime.shutdown()
    }
  }
}

export function langfuseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LangfuseReporterConfig {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim()
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim()
  const baseUrl = env.LANGFUSE_BASE_URL?.trim() || 'https://cloud.langfuse.com'
  if (!publicKey || !secretKey) throw new Error('Langfuse Reporter 缺少 LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY')
  return { publicKey, secretKey, baseUrl }
}

export function createLangfuseRuntime(config: LangfuseReporterConfig): LangfuseRuntime {
  const processor = new LangfuseSpanProcessor({ ...config, mediaUploadEnabled: false })
  const otelSdk = new NodeSDK({ spanProcessors: [processor] })
  otelSdk.start()
  const client = new LangfuseClient(config)
  return {
    createDataset: async (input) => { await client.createDataset(input) },
    createDatasetItem: async (input) => { await client.dataset.createItem(input) },
    getDatasetInputs: async (name) => {
      const dataset = await client.dataset.get(name)
      return dataset.items.map((item) => item.input as DatasetInput)
    },
    runExperiment: async (name, params) => {
      const dataset = await client.dataset.get(name)
      const result = await dataset.runExperiment({
        ...params,
        task: async (item) => params.task(item.input as DatasetInput),
        evaluators: params.evaluators.map((evaluator) => async ({ output }) =>
          evaluator(output as ReporterCaseOutput)),
      })
      return {
        experimentId: result.experimentId,
        ...(result.datasetRunUrl ? { datasetRunUrl: result.datasetRunUrl } : {}),
      }
    },
    shutdown: async () => {
      await client.flush()
      await client.shutdown()
      await otelSdk.shutdown()
    },
  }
}
