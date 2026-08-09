export type EvalAgent = 'claude' | 'codex' | 'copilot' | 'cursor' | 'opencode' | 'pi'
export type EvalVariant = 'v0-prompt-only' | 'v1-strict-prompt' | 'v2-live-read' | 'v3-map-reduce'

export interface EvalLocator {
  sessionId: string
  agent: EvalAgent
  messageIndex: number
}

export interface SessionEvidenceEvalCase {
  caseId: string
  caseHash: string
  requestText: string
  expectedMode: 'complete' | 'targeted'
  selected: Array<{ agent: EvalAgent; id: string }>
  messages: Record<string, string[]>
  goldRelevantSessionIds: string[]
  goldFacts: Array<{ id: string; acceptableLocators: EvalLocator[] }>
  unavailableSessionIds: string[]
  readFailedSessionIds: string[]
  forbiddenClaims: string[]
  tags: string[]
}

export interface VariantCaseResult {
  caseId: string
  caseHash: string
  variant: EvalVariant
  visitedSessionIds: string[]
  processedSessionIds: string[]
  sourceOutcomes: Array<{
    sessionId: string
    status: 'readable' | 'unavailable' | 'read_failed'
  }>
  processingOutcomes: Array<{
    sessionId: string
    status: 'processed' | 'process_failed'
  }>
  coverageStatus: 'complete' | 'targeted' | 'partial' | 'failed'
  relevantSessionIds: string[]
  facts: Array<{ id: string; locators: EvalLocator[] }>
  visibleOutput: string
  calls: number
  inputTokens: number
  outputTokens: number
  readBytes: number
  retries: number
  latencyMs: number
}

export type HardGateName =
  | 'source_accounting_pass'
  | 'processing_accounting_pass'
  | 'false_complete_claim_pass'
  | 'locator_validity'
  | 'secret_leak_pass'

export interface HardGateResult {
  name: HardGateName
  passed: boolean
  violations: string[]
}

export interface CaseEvaluation {
  caseId: string
  caseHash: string
  gates: HardGateResult[]
  hardGatesPassed: boolean
}
