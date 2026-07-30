import {
  getRuleCandidate,
  listRuleCandidates,
  updateRuleCandidateStatus,
  type RuleCandidateRow,
} from '../rule-candidates.js'

interface RulesReviewOptions {
  homeDir?: string
}

function summary(row: RuleCandidateRow): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    projectSlug: row.project_slug,
    ruleText: row.rule_text,
    confidenceLevel: row.confidence_level,
    status: row.status,
    sourceSessions: JSON.parse(row.source_sessions),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function runRulesReview(opts: RulesReviewOptions = {}): void {
  const candidates = listRuleCandidates(opts.homeDir)
  console.log(JSON.stringify({ count: candidates.length, candidates: candidates.map(summary) }, null, 2))
}

export function runRulesAccept(id: string, opts: RulesReviewOptions = {}): void {
  console.log(JSON.stringify(summary(updateRuleCandidateStatus(id, 'accepted', opts.homeDir)), null, 2))
}

export function runRulesReject(id: string, opts: RulesReviewOptions = {}): void {
  console.log(JSON.stringify(summary(updateRuleCandidateStatus(id, 'rejected', opts.homeDir)), null, 2))
}

export function runRulesExplain(id: string, opts: RulesReviewOptions = {}): void {
  const row = getRuleCandidate(id, opts.homeDir)
  let evidence: unknown
  try {
    evidence = JSON.parse(row.evidence_json)
  } catch {
    throw new Error(`rule candidate evidence_json 损坏：${id}`)
  }
  const evidenceRecord = evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence)
    ? evidence as Record<string, unknown>
    : {}
  console.log(JSON.stringify({
    ...summary(row),
    reasoning: evidenceRecord.reasoning ?? null,
    evidenceRefs: evidenceRecord.evidence_refs ?? [],
    evidence: evidenceRecord.bundle ?? evidence,
  }, null, 2))
}
