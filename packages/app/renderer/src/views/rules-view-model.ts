import type { GenerationHistoryEntry, ProviderSnapshotEntry, RuleCandidate } from '../types'

export function generationProviderEntries(
  entries: ProviderSnapshotEntry[],
): ProviderSnapshotEntry[] {
  return entries.filter((entry) => entry.capabilities.supportsStructuredOutput)
}

export interface EvidenceReference {
  raw: string
  sessionId: string
  messageIndex: number
  agent?: string
  timestamp?: string
}

export interface CandidateEvidence {
  reasoning: string
  references: EvidenceReference[]
  sourceSessions: string[]
  invalidReferenceCount: number
  parseError: boolean
}

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

export function parseEvidenceReference(value: string): EvidenceReference | null {
  const raw = value.trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof parsed.sessionId !== 'string'
      || !parsed.sessionId.trim()
      || !Number.isInteger(parsed.messageIndex)
      || Number(parsed.messageIndex) < 0
    ) {
      return null
    }
    return {
      raw,
      sessionId: parsed.sessionId,
      messageIndex: Number(parsed.messageIndex),
      ...(typeof parsed.agent === 'string' && parsed.agent.trim()
        ? { agent: parsed.agent }
        : {}),
      ...(typeof parsed.timestamp === 'string' && parsed.timestamp.trim()
        ? { timestamp: parsed.timestamp }
        : {}),
    }
  } catch {
    const match = raw.match(/^(.+):(\d+)$/)
    if (!match) return null
    return {
      raw,
      sessionId: match[1],
      messageIndex: Number(match[2]),
    }
  }
}

export function parseCandidateEvidence(
  evidenceJson: string,
  sourceSessionsJson: string,
): CandidateEvidence {
  let reasoning = '—'
  let rawReferences: string[] = []
  let parseError = false
  try {
    const parsed = JSON.parse(evidenceJson) as Record<string, unknown>
    reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '—'
    rawReferences = Array.isArray(parsed.evidence_refs)
      ? parsed.evidence_refs.map(String)
      : []
  } catch {
    parseError = true
  }

  let sourceSessions: string[] = []
  try {
    const parsed = JSON.parse(sourceSessionsJson) as unknown
    sourceSessions = Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    parseError = true
  }
  const parsedReferences = rawReferences.map(parseEvidenceReference)
  return {
    reasoning,
    references: parsedReferences.filter(
      (reference): reference is EvidenceReference => reference !== null,
    ),
    sourceSessions,
    invalidReferenceCount: parsedReferences.filter((reference) => reference === null).length,
    parseError,
  }
}
