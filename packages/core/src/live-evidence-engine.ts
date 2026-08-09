import { z } from 'zod'
import { isRunCancelledError, throwIfAborted } from './abort.js'
import {
  createCoverageState,
  finalizeCoverage,
  recordProcessingOutcome,
  recordSourceOutcome,
  type CoverageLedger,
  type CoverageStatus,
  type SessionEvidenceMode,
  type SessionEvidenceReference,
} from './evidence-coverage.js'
import {
  withLiveEvidenceContext,
  type SessionCapsule,
} from './live-evidence-context.js'
import { containsSecret, redactSecrets } from './redaction.js'
import {
  readSessionSources,
  type SessionSourceReadResult,
} from './session-source-reader.js'
import type { AgentName } from './types.js'

export interface SessionEvidencePlan {
  runId: string
  mode: SessionEvidenceMode
  selected: SessionEvidenceReference[]
  reason: string
  batchByteBudget: number
  maxConcurrency: number
}

export interface CurrentNativeChat {
  chatId: string
  nativeSessionId?: string | null
  nativeHandle?: string | null
}

export interface SessionEvidenceQuery {
  question: string
  currentChat: CurrentNativeChat
}

export interface EvidenceMapInput {
  runId: string
  question: string
  sessionId: string
  agent: AgentName
  chunkIndex: number
  chunkCount: number
  chunkPath: string
  sourceRevision: string
}

export interface EvidenceReduceInput {
  runId: string
  question: string
  mode: SessionEvidenceMode
  currentChat: CurrentNativeChat
  evidence: EvidenceReduceMaterial[]
  coverage: CoverageLedger
}

export interface EvidenceReduceBatchInput {
  runId: string
  question: string
  level: number
  batchIndex: number
  batchCount: number
  evidence: EvidenceReduceMaterial[]
}

export interface EvidenceReduceBatchResult {
  summary: string
  evidenceFactIds: string[]
}

export type EvidenceReduceMaterial =
  | { kind: 'capsule'; capsule: SessionCapsule }
  | { kind: 'batch'; batch: EvidenceReduceBatchResult }

export interface SessionEvidenceSynthesis {
  answerMarkdown: string
  claims: Array<{
    text: string
    evidenceFactIds: string[]
  }>
  limitations: string[]
}

export interface EvidenceModelRunner {
  runMap(input: EvidenceMapInput): Promise<SessionCapsule>
  runReduceBatch(input: EvidenceReduceBatchInput): Promise<EvidenceReduceBatchResult>
  runReduce(input: EvidenceReduceInput): Promise<SessionEvidenceSynthesis>
}

export type ClaimGateViolation =
  | 'false-complete-claim'
  | 'unknown-evidence-ref'
  | 'missing-limitations'
  | 'secret-leak'

export interface ClaimGateResult {
  allowed: boolean
  coverageStatus: CoverageStatus
  violations: ClaimGateViolation[]
  renderedAnswer: string
}

export interface SessionEvidenceRunResult {
  runId: string
  plan: SessionEvidencePlan
  synthesis: SessionEvidenceSynthesis
  capsules: SessionCapsule[]
  coverage: CoverageLedger
  claimGate: ClaimGateResult
  renderedAnswer: string
}

export interface LiveSessionEvidenceOptions {
  homeDir?: string
  tempParentDir?: string
  signal?: AbortSignal
  onProgress?: (progress: SessionEvidenceProgress) => void
}

export type SessionEvidenceStage =
  | 'planning'
  | 'reading'
  | 'processing'
  | 'reducing'
  | 'gating'
  | 'complete'

export interface SessionEvidenceCoverageSummary {
  mode: SessionEvidenceMode
  status: CoverageStatus
  selected: number
  visited: number
  readable: number
  empty: number
  unavailable: number
  readFailed: number
  processed: number
  processFailed: number
  relevant: number
  changedDuringRun: number
}

export interface SessionEvidenceProgress {
  stage: SessionEvidenceStage
  completed: number
  total: number
  mode: SessionEvidenceMode
  coverage?: SessionEvidenceCoverageSummary
}

const COMPLETE_CLAIM = /(?:全部(?:读取|处理|总结|覆盖)|完整(?:读取|处理|总结|覆盖)|所有会话(?:都|均)?(?:已)?(?:读取|处理|总结|覆盖)|(?:已)?(?:读取|处理|总结|覆盖)(?:了)?(?:全部|所有)(?:会话|sessions?)|没有遗漏|无遗漏|all sessions|complete coverage|reviewed all sessions|no omissions?)/i
const agentSchema = z.enum(['claude', 'codex', 'copilot', 'cursor', 'opencode', 'pi'])
const locatorSchema = z.object({
  sessionId: z.string().min(1),
  agent: agentSchema,
  messageIndex: z.number().int().nonnegative(),
  timestamp: z.string().optional(),
  sourceRevision: z.string().min(1),
})
const capsuleSchema = z.object({
  sessionId: z.string().min(1),
  agent: agentSchema,
  chunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive(),
  summary: z.string(),
  facts: z.array(z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    kind: z.enum(['explicit', 'inferred']),
    locators: z.array(locatorSchema).min(1),
  })),
  relevant: z.boolean(),
})
const synthesisSchema = z.object({
  answerMarkdown: z.string(),
  claims: z.array(z.object({
    text: z.string().min(1),
    evidenceFactIds: z.array(z.string().min(1)),
  })),
  limitations: z.array(z.string()),
})
const reduceBatchSchema = z.object({
  summary: z.string(),
  evidenceFactIds: z.array(z.string().min(1)),
})

function outputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _schema, ...portable } = z.toJSONSchema(schema) as Record<string, unknown>
  return portable
}

export function sessionCapsuleOutputSchema(): Record<string, unknown> {
  return outputSchema(capsuleSchema)
}

export function sessionEvidenceSynthesisOutputSchema(): Record<string, unknown> {
  return outputSchema(synthesisSchema)
}

export function evidenceReduceBatchOutputSchema(): Record<string, unknown> {
  return outputSchema(reduceBatchSchema)
}

export function parseSessionCapsule(value: unknown): SessionCapsule {
  return capsuleSchema.parse(value) as SessionCapsule
}

export function parseSessionEvidenceSynthesis(value: unknown): SessionEvidenceSynthesis {
  return synthesisSchema.parse(value)
}

export function parseEvidenceReduceBatch(value: unknown): EvidenceReduceBatchResult {
  return reduceBatchSchema.parse(value)
}

function validatePlan(plan: SessionEvidencePlan): void {
  if (!plan.reason.trim()) throw new Error('session evidence plan reason is required')
  if (!Number.isInteger(plan.batchByteBudget) || plan.batchByteBudget <= 0) {
    throw new Error('session evidence batch byte budget must be a positive integer')
  }
  if (!Number.isInteger(plan.maxConcurrency) || plan.maxConcurrency <= 0) {
    throw new Error('session evidence max concurrency must be a positive integer')
  }
}

export function sessionEvidenceCoverageSummary(
  coverage: CoverageLedger,
): SessionEvidenceCoverageSummary {
  return {
    mode: coverage.mode,
    status: coverage.status,
    selected: coverage.selected,
    visited: coverage.visited,
    readable: coverage.readable,
    empty: coverage.empty,
    unavailable: coverage.unavailable,
    readFailed: coverage.readFailed,
    processed: coverage.processed,
    processFailed: coverage.processFailed,
    relevant: coverage.relevant,
    changedDuringRun: coverage.changedDuringRun,
  }
}

function validateCapsule(
  capsule: SessionCapsule,
  input: EvidenceMapInput,
): void {
  if (
    capsule.sessionId !== input.sessionId
    || capsule.agent !== input.agent
    || capsule.chunkIndex !== input.chunkIndex
    || capsule.chunkCount !== input.chunkCount
  ) {
    throw new Error(`map capsule identity does not match session ${input.sessionId}`)
  }
}

function materialFactIds(material: EvidenceReduceMaterial): string[] {
  return material.kind === 'capsule'
    ? material.capsule.facts.map((fact) => fact.id)
    : material.batch.evidenceFactIds
}

function validateReducedBatch(
  batch: EvidenceReduceBatchResult,
  input: EvidenceReduceBatchInput,
): void {
  const available = new Set(input.evidence.flatMap(materialFactIds))
  if (batch.evidenceFactIds.some((factId) => !available.has(factId))) {
    throw new Error('reduce batch contains an unknown evidence fact id')
  }
}

async function runWithConcurrency<T, R>(
  values: T[],
  maxConcurrency: number,
  task: (value: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(values.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      throwIfAborted(signal)
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await task(values[index]) }
      } catch (error) {
        if (isRunCancelledError(error)) throw error
        results[index] = { status: 'rejected', reason: error }
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(maxConcurrency, values.length) },
    () => worker(),
  ))
  return results
}

function partitionReduceMaterials(
  materials: EvidenceReduceMaterial[],
  byteBudget: number,
): EvidenceReduceMaterial[][] {
  const batches: EvidenceReduceMaterial[][] = []
  let batch: EvidenceReduceMaterial[] = []
  let batchBytes = 0
  for (const material of materials) {
    const bytes = Buffer.byteLength(JSON.stringify(material), 'utf8')
    if (batch.length > 0 && batchBytes + bytes > byteBudget) {
      batches.push(batch)
      batch = []
      batchBytes = 0
    }
    batch.push(material)
    batchBytes += bytes
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

async function reduceEvidenceLayers(
  plan: SessionEvidencePlan,
  question: string,
  capsules: SessionCapsule[],
  runner: EvidenceModelRunner,
  signal?: AbortSignal,
): Promise<EvidenceReduceMaterial[]> {
  let evidence: EvidenceReduceMaterial[] = capsules.map((capsule) => ({ kind: 'capsule', capsule }))
  let level = 0
  while (evidence.length > 1) {
    const batches = partitionReduceMaterials(evidence, plan.batchByteBudget)
    if (batches.length <= 1 || batches.length === evidence.length) break
    const reduced = await runWithConcurrency(
      batches,
      plan.maxConcurrency,
      async (batchEvidence) => {
        const batchIndex = batches.indexOf(batchEvidence)
        const input: EvidenceReduceBatchInput = {
          runId: plan.runId,
          question,
          level,
          batchIndex,
          batchCount: batches.length,
          evidence: batchEvidence,
        }
        const batch = await runner.runReduceBatch(input)
        validateReducedBatch(batch, input)
        return { kind: 'batch', batch } satisfies EvidenceReduceMaterial
      },
      signal,
    )
    const failed = reduced.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    evidence = reduced.map((result) => (result as PromiseFulfilledResult<EvidenceReduceMaterial>).value)
    level += 1
  }
  return evidence
}

export function applyClaimGate(
  synthesis: SessionEvidenceSynthesis,
  capsules: SessionCapsule[],
  coverage: CoverageLedger,
): ClaimGateResult {
  const violations = new Set<ClaimGateViolation>()
  const processed = new Map<string, CoverageLedger['rows'][number]>(coverage.rows
    .filter((row) => row.processingStatus === 'processed')
    .map((row) => [`${row.agent}\0${row.sessionId}`, row] as const))
  const facts = new Map<string, SessionCapsule['facts'][number]>()

  for (const capsule of capsules) {
    const capsuleKey = `${capsule.agent}\0${capsule.sessionId}`
    const row = processed.get(capsuleKey)
    if (!row) violations.add('unknown-evidence-ref')
    for (const fact of capsule.facts) {
      if (facts.has(fact.id)) violations.add('unknown-evidence-ref')
      facts.set(fact.id, fact)
      const uniqueLocators = new Set(fact.locators.map((locator) =>
        `${locator.agent}\0${locator.sessionId}\0${locator.messageIndex}\0${locator.sourceRevision}`))
      if (fact.kind === 'inferred' && uniqueLocators.size < 2) {
        violations.add('unknown-evidence-ref')
      }
      if (fact.locators.some((locator) => {
        const locatorRow = processed.get(`${locator.agent}\0${locator.sessionId}`)
        return locator.agent !== capsule.agent
          || locator.sessionId !== capsule.sessionId
          || !locatorRow
          || locator.sourceRevision !== locatorRow.sourceRevision?.fingerprint
          || locator.messageIndex < 0
          || locator.messageIndex >= locatorRow.messageCount
      })) {
        violations.add('unknown-evidence-ref')
      }
    }
  }
  if (synthesis.claims.some((claim) => claim.evidenceFactIds.length === 0
    || claim.evidenceFactIds.some((factId) => !facts.has(factId)))) {
    violations.add('unknown-evidence-ref')
  }
  const outputText = [
    synthesis.answerMarkdown,
    ...synthesis.claims.map((claim) => claim.text),
    ...synthesis.limitations,
  ].join('\n')
  if (coverage.status !== 'complete' && COMPLETE_CLAIM.test(outputText)) {
    violations.add('false-complete-claim')
  }
  if (
    (coverage.status === 'partial' || coverage.status === 'failed')
    && !synthesis.limitations.some((limitation) => limitation.trim())
  ) {
    violations.add('missing-limitations')
  }
  if (containsSecret(outputText)) violations.add('secret-leak')

  let renderedAnswer = redactSecrets(synthesis.answerMarkdown)
  if (violations.has('unknown-evidence-ref') || violations.has('false-complete-claim')) {
    renderedAnswer = '证据声明校验失败，无法安全展示本轮总结。'
  } else if (coverage.status === 'failed') {
    renderedAnswer = '本轮未能读取或处理可用证据，无法生成可靠总结。'
  } else if (coverage.status === 'partial') {
    renderedAnswer = [
      `> 本轮仅部分完成：${coverage.unavailable} 个来源不可用，${coverage.readFailed} 个读取失败，${coverage.processFailed} 个处理失败。`,
      '',
      renderedAnswer,
      '',
      ...synthesis.limitations
        .filter((limitation) => limitation.trim())
        .map((limitation) => `- ${redactSecrets(limitation)}`),
    ].join('\n')
  } else if (coverage.status === 'targeted') {
    renderedAnswer = `> 以下结论仅基于本次处理的证据。\n\n${renderedAnswer}`
  }
  if (coverage.changedDuringRun > 0) {
    renderedAnswer = [
      `> 本轮有 ${coverage.changedDuringRun} 个来源在读取期间发生变化；结论基于固定读取水位。`,
      '',
      renderedAnswer,
    ].join('\n')
  }

  return {
    allowed: violations.size === 0,
    coverageStatus: coverage.status,
    violations: [...violations],
    renderedAnswer,
  }
}

export async function runLiveSessionEvidence(
  query: SessionEvidenceQuery,
  plan: SessionEvidencePlan,
  runner: EvidenceModelRunner,
  options: LiveSessionEvidenceOptions = {},
): Promise<SessionEvidenceRunResult> {
  if (!query.question.trim()) throw new Error('session evidence question is required')
  validatePlan(plan)
  options.onProgress?.({
    stage: 'planning', completed: 0, total: plan.selected.length, mode: plan.mode,
  })
  let coverageState = createCoverageState(plan.runId, plan.mode, plan.selected)
  const sourceResults = await readSessionSources(plan.selected, {
    homeDir: options.homeDir,
    signal: options.signal,
    onVisit: (_reference, index, total) => options.onProgress?.({
      stage: 'reading', completed: index, total, mode: plan.mode,
    }),
  })
  options.onProgress?.({
    stage: 'reading', completed: sourceResults.length, total: plan.selected.length, mode: plan.mode,
  })
  for (const source of sourceResults) {
    coverageState = recordSourceOutcome(coverageState, {
      id: source.sessionId,
      agent: source.agent,
      status: source.status,
      messageCount: source.messageCount,
      ...(source.sourceRevision ? { sourceRevision: source.sourceRevision } : {}),
      ...(source.errorCode ? { errorCode: source.errorCode } : {}),
      ...(source.errorMessage ? { errorMessage: source.errorMessage } : {}),
    })
  }

  return withLiveEvidenceContext({
    runId: plan.runId,
    mode: plan.mode,
    selected: plan.selected,
  }, {
    parentDir: options.tempParentDir,
    maxChunkBytes: plan.batchByteBudget,
  }, async (context) => {
    const capsules: SessionCapsule[] = []
    const readableCount = sourceResults.filter((source) => source.status === 'readable').length
    let processedSessionCount = 0
    options.onProgress?.({
      stage: 'processing', completed: 0, total: readableCount, mode: plan.mode,
    })
    const sessions: Array<{
      source: SessionSourceReadResult
      jobs: EvidenceMapInput[]
    }> = []
    for (const source of sourceResults) {
      if (source.status !== 'readable') continue
      try {
        const sessionSource = context.writeSessionChunks(source)
        sessions.push({
          source,
          jobs: sessionSource.chunkPaths.map((chunkPath, chunkIndex) => ({
            runId: plan.runId,
            question: query.question,
            sessionId: source.sessionId,
            agent: source.agent,
            chunkIndex,
            chunkCount: sessionSource.chunkCount,
            chunkPath,
            sourceRevision: source.sourceRevision!.fingerprint,
          })),
        })
      } catch (error) {
        if (isRunCancelledError(error)) throw error
        coverageState = recordProcessingOutcome(coverageState, {
          id: source.sessionId,
          agent: source.agent,
          status: 'failed',
          relevant: false,
          errorCode: 'MAP_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        processedSessionCount += 1
        options.onProgress?.({
          stage: 'processing', completed: processedSessionCount,
          total: readableCount, mode: plan.mode,
        })
      }
    }

    const jobs = sessions.flatMap((session) => session.jobs)
    const mapResults = await runWithConcurrency(
      jobs,
      plan.maxConcurrency,
      async (mapInput) => {
        const capsule = await runner.runMap(mapInput)
        validateCapsule(capsule, mapInput)
        context.writeCapsule(capsule)
        return capsule
      },
      options.signal,
    )
    const resultByJob = new Map(jobs.map((job, index) => [job, mapResults[index]]))
    for (const { source, jobs: sessionJobs } of sessions) {
      const sessionResults = sessionJobs.map((job) => resultByJob.get(job)!)
      const failure = sessionResults.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') {
        coverageState = recordProcessingOutcome(coverageState, {
          id: source.sessionId,
          agent: source.agent,
          status: 'failed',
          relevant: false,
          errorCode: 'MAP_FAILED',
          errorMessage: failure.reason instanceof Error
            ? failure.reason.message
            : String(failure.reason),
        })
        processedSessionCount += 1
        options.onProgress?.({
          stage: 'processing', completed: processedSessionCount,
          total: readableCount, mode: plan.mode,
        })
        continue
      }
      const sessionCapsules = sessionResults.map((result) =>
        (result as PromiseFulfilledResult<SessionCapsule>).value)
      capsules.push(...sessionCapsules)
      coverageState = recordProcessingOutcome(coverageState, {
        id: source.sessionId,
        agent: source.agent,
        status: 'processed',
        relevant: sessionCapsules.some((capsule) => capsule.relevant),
      })
      processedSessionCount += 1
      options.onProgress?.({
        stage: 'processing', completed: processedSessionCount,
        total: readableCount, mode: plan.mode,
      })
    }

    const coverage = finalizeCoverage(coverageState)
    context.writeCoverage(coverage)
    options.onProgress?.({
      stage: 'reducing', completed: 0, total: 1, mode: plan.mode,
      coverage: sessionEvidenceCoverageSummary(coverage),
    })
    const evidence = await reduceEvidenceLayers(
      plan,
      query.question,
      capsules,
      runner,
      options.signal,
    )
    throwIfAborted(options.signal)
    const synthesis = await runner.runReduce({
      runId: plan.runId,
      question: query.question,
      mode: plan.mode,
      currentChat: query.currentChat,
      evidence,
      coverage,
    })
    options.onProgress?.({
      stage: 'gating', completed: 0, total: 1, mode: plan.mode,
      coverage: sessionEvidenceCoverageSummary(coverage),
    })
    const claimGate = applyClaimGate(synthesis, capsules, coverage)
    options.onProgress?.({
      stage: 'complete', completed: 1, total: 1, mode: plan.mode,
      coverage: sessionEvidenceCoverageSummary(coverage),
    })
    return {
      runId: plan.runId,
      plan,
      synthesis,
      capsules,
      coverage,
      claimGate,
      renderedAnswer: claimGate.renderedAnswer,
    }
  }, options.signal)
}
