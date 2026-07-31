import type { GenerationHistoryEntry, RuleCandidate } from '../types'

export function filterCandidatesByRun(
  candidates: RuleCandidate[],
  runId: string | null,
): RuleCandidate[] {
  if (runId === null) return candidates
  return candidates.filter((candidate) => candidate.run_id === runId)
}

export function selectableGenerationRuns(
  history: GenerationHistoryEntry[],
): GenerationHistoryEntry[] {
  return history.filter((entry) =>
    entry.candidateCount > 0 || entry.candidates.length > 0)
}
