import type {
  SessionEvidencePlan,
} from './live-evidence-engine.js'
import type { SessionEvidenceReference } from './evidence-coverage.js'

export type SessionEvidenceRequestMode = 'auto' | 'complete' | 'targeted'

export interface SessionEvidencePlanningInput {
  runId: string
  question: string
  selected: SessionEvidenceReference[]
  mode?: SessionEvidenceRequestMode
  batchByteBudget?: number
  maxConcurrency?: number
}

const COMPLETE_INTENT = /(?:全部|所有|完整|总结(?:这些|所有)?\s*(?:session|会话)|归纳(?:经验|教训)|跨(?:session|会话)|覆盖情况|全面|overall|all sessions|every session|summari[sz]e (?:these|all) sessions|lessons? learned|across sessions)/i
const TARGETED_INTENT = /(?:找(?:一下|出)?|查(?:一下|找)?|哪(?:个|条)|某个|具体|例子|曾经|之前.{0,12}(?:什么|哪个|如何)|find|look up|which|specific|example|where did|what did)/i
const DEFAULT_BATCH_BYTE_BUDGET = 512 * 1024
const DEFAULT_MAX_CONCURRENCY = 4
const DEFAULT_TARGETED_SESSION_LIMIT = 24

export function planSessionEvidence(
  input: SessionEvidencePlanningInput,
): SessionEvidencePlan | null {
  if (input.selected.length === 0) return null
  if (!input.question.trim()) throw new Error('session evidence planning question is required')
  const requestedMode = input.mode ?? 'auto'
  const mode = requestedMode === 'auto'
    ? inferMode(input.question)
    : requestedMode
  return {
    runId: input.runId,
    mode,
    selected: input.selected.map((reference) => ({ ...reference })),
    reason: planningReason(requestedMode, mode),
    batchByteBudget: input.batchByteBudget ?? DEFAULT_BATCH_BYTE_BUDGET,
    maxConcurrency: input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    targetedSessionLimit: DEFAULT_TARGETED_SESSION_LIMIT,
  }
}

function planningReason(
  requestedMode: SessionEvidenceRequestMode,
  mode: 'complete' | 'targeted',
): string {
  if (requestedMode !== 'auto') return `用户显式指定 ${mode} 模式`
  return mode === 'complete'
    ? '集合级或不确定请求，使用完整证据覆盖'
    : '单点历史检索请求，使用目标证据范围'
}

function inferMode(question: string): 'complete' | 'targeted' {
  if (COMPLETE_INTENT.test(question)) return 'complete'
  if (TARGETED_INTENT.test(question)) return 'targeted'
  return 'complete'
}
