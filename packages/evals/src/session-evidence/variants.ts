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
  if (variant === 'v0-prompt-only' || variant === 'v1-strict-prompt') {
    const falsePositive = processed.find((reference) =>
      !testCase.goldRelevantSessionIds.includes(reference.id))
    if (falsePositive) relevant.push(falsePositive.id)
  }
  const facts = variant === 'v3-map-reduce'
    ? testCase.goldFacts.map((fact) => ({ id: fact.id, locators: fact.acceptableLocators }))
    : testCase.goldFacts.slice(0, Math.ceil(testCase.goldFacts.length / 2))
      .map((fact) => ({ id: fact.id, locators: fact.acceptableLocators }))
  const readBytes = processed.reduce((total, reference) =>
    total + Buffer.byteLength(testCase.messages[reference.id].join('\n')), 0)
  const sourceReferences = variant === 'v0-prompt-only' ? visited : testCase.selected
  const sourceOutcomes = sourceReferences.map((reference) => ({
    sessionId: reference.id,
    status: testCase.unavailableSessionIds.includes(reference.id)
      ? 'unavailable' as const
      : testCase.readFailedSessionIds.includes(reference.id)
        ? 'read_failed' as const
        : 'readable' as const,
  }))
  const processingOutcomes = processed.map((reference) => ({
    sessionId: reference.id,
    status: 'processed' as const,
  }))
  const incomplete = sourceOutcomes.length !== testCase.selected.length
    || processed.length !== readable.length
    || testCase.unavailableSessionIds.length > 0
    || testCase.readFailedSessionIds.length > 0
  const coverageStatus = testCase.expectedMode === 'targeted'
    ? 'targeted' as const
    : incomplete ? 'partial' as const : 'complete' as const
  const unsafeClaim = variant === 'v0-prompt-only'
    ? '已读取所有 Session 且没有遗漏。'
    : ''
  const leakedSecret = variant === 'v0-prompt-only' && testCase.tags.includes('secret')
    ? ' token=fixture@example.invalid'
    : ''
  return {
    caseId: testCase.caseId,
    caseHash: testCase.caseHash,
    variant,
    visitedSessionIds: visited.map((reference) => reference.id),
    processedSessionIds: processed.map((reference) => reference.id),
    sourceOutcomes,
    processingOutcomes,
    coverageStatus,
    relevantSessionIds: relevant,
    facts,
    visibleOutput: `${unsafeClaim}${variant}：基于 ${processed.length} 个 Session 的人工脱敏评测结果。${leakedSecret}`,
    calls: variant === 'v3-map-reduce' ? processed.length + 1 : 1,
    inputTokens: Math.ceil(readBytes / 4),
    outputTokens: facts.length * 20,
    readBytes,
    retries: 0,
    latencyMs: processed.length,
  }
}
