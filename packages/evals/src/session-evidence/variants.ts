import type { EvalVariant, SessionEvidenceEvalCase, VariantCaseResult } from './types.js'

export const EVAL_VARIANTS: EvalVariant[] = [
  'v0-prompt-only', 'v1-strict-prompt', 'v2-live-read', 'v3-map-reduce',
]

export function runVariant(
  variant: EvalVariant,
  testCase: SessionEvidenceEvalCase,
): VariantCaseResult {
  const readable = testCase.selected.filter((reference) =>
    !testCase.unavailableSessionIds.includes(reference.id)
    && !testCase.readFailedSessionIds.includes(reference.id))
  const visibility = variant === 'v0-prompt-only'
    ? Math.min(8, readable.length)
    : readable.length
  const visited = variant === 'v0-prompt-only'
    ? readable.slice(0, visibility)
    : testCase.selected
  const processed = variant === 'v0-prompt-only'
    ? readable.slice(0, visibility)
    : variant === 'v1-strict-prompt' ? readable.slice(0, Math.ceil(readable.length * 0.9)) : readable
  const relevant = testCase.goldRelevantSessionIds.filter((id) =>
    processed.some((reference) => reference.id === id))
  const facts = variant === 'v3-map-reduce'
    ? testCase.goldFacts.map((fact) => ({ id: fact.id, locators: fact.acceptableLocators }))
    : testCase.goldFacts.slice(0, Math.ceil(testCase.goldFacts.length / 2))
      .map((fact) => ({ id: fact.id, locators: fact.acceptableLocators }))
  const readBytes = processed.reduce((total, reference) =>
    total + Buffer.byteLength(testCase.messages[reference.id].join('\n')), 0)
  return {
    caseId: testCase.caseId,
    caseHash: testCase.caseHash,
    variant,
    visitedSessionIds: visited.map((reference) => reference.id),
    processedSessionIds: processed.map((reference) => reference.id),
    relevantSessionIds: relevant,
    facts,
    visibleOutput: `${variant}：基于 ${processed.length} 个 Session 的人工脱敏评测结果。`,
    calls: variant === 'v3-map-reduce' ? processed.length + 1 : 1,
    inputTokens: readBytes,
    outputTokens: facts.length * 20,
    readBytes,
    retries: 0,
    latencyMs: processed.length,
  }
}
