import { z } from 'zod'
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
import { readSessionSources } from './session-source-reader.js'
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
  capsules: SessionCapsule[]
  coverage: CoverageLedger
}

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
}

const COMPLETE_CLAIM = /(?:全部(?:读取|处理|总结)|完整总结|没有遗漏|all sessions|complete coverage)/i
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

export function parseSessionCapsule(value: unknown): SessionCapsule {
  return capsuleSchema.parse(value) as SessionCapsule
}

export function parseSessionEvidenceSynthesis(value: unknown): SessionEvidenceSynthesis {
  return synthesisSchema.parse(value)
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

export function applyClaimGate(
  synthesis: SessionEvidenceSynthesis,
  capsules: SessionCapsule[],
  coverage: CoverageLedger,
): ClaimGateResult {
  const violations = new Set<ClaimGateViolation>()
  const processed = new Set(coverage.rows
    .filter((row) => row.processingStatus === 'processed')
    .map((row) => `${row.agent}\0${row.sessionId}`))
  const facts = new Map(capsules.flatMap((capsule) => capsule.facts)
    .map((fact) => [fact.id, fact] as const))

  for (const fact of facts.values()) {
    if (fact.locators.some((locator) => !processed.has(`${locator.agent}\0${locator.sessionId}`))) {
      violations.add('unknown-evidence-ref')
    }
  }
  if (synthesis.claims.some((claim) =>
    claim.evidenceFactIds.some((factId) => !facts.has(factId)))) {
    violations.add('unknown-evidence-ref')
  }
  if (coverage.status !== 'complete' && COMPLETE_CLAIM.test(synthesis.answerMarkdown)) {
    violations.add('false-complete-claim')
  }
  if (coverage.status === 'partial' && synthesis.limitations.length === 0) {
    violations.add('missing-limitations')
  }
  if (containsSecret(synthesis.answerMarkdown)) violations.add('secret-leak')

  let renderedAnswer = redactSecrets(synthesis.answerMarkdown)
  if (violations.has('unknown-evidence-ref') || violations.has('false-complete-claim')) {
    renderedAnswer = '证据声明校验失败，无法安全展示本轮总结。'
  } else if (coverage.status === 'partial') {
    renderedAnswer = [
      `> 本轮仅部分完成：${coverage.unavailable} 个来源不可用，${coverage.readFailed} 个读取失败，${coverage.processFailed} 个处理失败。`,
      '',
      renderedAnswer,
      '',
      ...synthesis.limitations.map((limitation) => `- ${redactSecrets(limitation)}`),
    ].join('\n')
  } else if (coverage.status === 'targeted') {
    renderedAnswer = `> 以下结论仅基于本次处理的证据。\n\n${renderedAnswer}`
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
  let coverageState = createCoverageState(plan.runId, plan.mode, plan.selected)
  const sourceResults = await readSessionSources(plan.selected, {
    homeDir: options.homeDir,
    signal: options.signal,
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
    for (const source of sourceResults) {
      if (source.status !== 'readable') continue
      try {
        const sessionSource = context.writeSessionChunks(source)
        const sessionCapsules: SessionCapsule[] = []
        for (const [chunkIndex, chunkPath] of sessionSource.chunkPaths.entries()) {
          const mapInput: EvidenceMapInput = {
            runId: plan.runId,
            question: query.question,
            sessionId: source.sessionId,
            agent: source.agent,
            chunkIndex,
            chunkCount: sessionSource.chunkCount,
            chunkPath,
            sourceRevision: source.sourceRevision!.fingerprint,
          }
          const capsule = await runner.runMap(mapInput)
          validateCapsule(capsule, mapInput)
          context.writeCapsule(capsule)
          sessionCapsules.push(capsule)
        }
        capsules.push(...sessionCapsules)
        coverageState = recordProcessingOutcome(coverageState, {
          id: source.sessionId,
          agent: source.agent,
          status: 'processed',
          relevant: sessionCapsules.some((capsule) => capsule.relevant),
        })
      } catch (error) {
        coverageState = recordProcessingOutcome(coverageState, {
          id: source.sessionId,
          agent: source.agent,
          status: 'failed',
          relevant: false,
          errorCode: 'MAP_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const coverage = finalizeCoverage(coverageState)
    context.writeCoverage(coverage)
    const synthesis = await runner.runReduce({
      runId: plan.runId,
      question: query.question,
      mode: plan.mode,
      currentChat: query.currentChat,
      capsules,
      coverage,
    })
    const claimGate = applyClaimGate(synthesis, capsules, coverage)
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
