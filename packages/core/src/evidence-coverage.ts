import type { AgentName } from './types.js'

export type SessionEvidenceMode = 'complete' | 'targeted'

export interface SessionEvidenceReference {
  agent: AgentName
  id: string
}

export type SessionSourceStatus =
  | 'readable'
  | 'empty'
  | 'unavailable'
  | 'failed'

export type SessionProcessingStatus =
  | 'not_required'
  | 'pending'
  | 'processed'
  | 'failed'

export interface SourceRevision {
  kind: 'jsonl-watermark' | 'sqlite-transaction'
  fingerprint: string
  changedDuringRun: boolean
}

export interface SessionSourceOutcome extends SessionEvidenceReference {
  status: SessionSourceStatus
  messageCount: number
  sourceRevision?: SourceRevision
  errorCode?: string
  errorMessage?: string
}

export interface SessionProcessingOutcome extends SessionEvidenceReference {
  status: Exclude<SessionProcessingStatus, 'pending'>
  relevant: boolean
  errorCode?: string
  errorMessage?: string
}

interface SessionCoverageStateRow {
  sessionId: string
  agent: AgentName
  selected: true
  visited: boolean
  sourceStatus: SessionSourceStatus | 'pending'
  processingStatus: SessionProcessingStatus
  relevant: boolean
  messageCount: number
  sourceRevision?: SourceRevision
  errorCode?: string
  errorMessage?: string
}

export interface CoverageState {
  runId: string
  mode: SessionEvidenceMode
  rows: SessionCoverageStateRow[]
}

export interface SessionCoverageRow extends Omit<SessionCoverageStateRow, 'sourceStatus'> {
  sourceStatus: SessionSourceStatus
}

export type CoverageStatus = 'complete' | 'targeted' | 'partial' | 'failed'

export interface CoverageLedger {
  runId: string
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
  rows: SessionCoverageRow[]
}

export function createCoverageState(
  runId: string,
  mode: SessionEvidenceMode,
  selected: SessionEvidenceReference[],
): CoverageState {
  if (!runId.trim()) throw new Error('coverage run id is required')
  if (selected.length === 0) throw new Error('coverage selected sessions must not be empty')
  const keys = selected.map(referenceKey)
  if (new Set(keys).size !== keys.length) {
    throw new Error('selected session references must be unique')
  }
  return {
    runId,
    mode,
    rows: selected.map((reference) => {
      if (!reference.id.trim()) throw new Error('selected session id is required')
      return {
        sessionId: reference.id,
        agent: reference.agent,
        selected: true,
        visited: false,
        sourceStatus: 'pending',
        processingStatus: 'not_required',
        relevant: false,
        messageCount: 0,
      }
    }),
  }
}

export function recordSourceOutcome(
  state: CoverageState,
  outcome: SessionSourceOutcome,
): CoverageState {
  if (!Number.isInteger(outcome.messageCount) || outcome.messageCount < 0) {
    throw new Error('session message count must be a non-negative integer')
  }
  return updateRow(state, outcome, (row) => {
    if (row.sourceStatus !== 'pending') {
      throw new Error('session source outcome is already recorded')
    }
    return {
      ...row,
      visited: true,
      sourceStatus: outcome.status,
      processingStatus: outcome.status === 'readable' ? 'pending' : 'not_required',
      messageCount: outcome.messageCount,
      ...(outcome.sourceRevision ? { sourceRevision: { ...outcome.sourceRevision } } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
    }
  })
}

export function recordProcessingOutcome(
  state: CoverageState,
  outcome: SessionProcessingOutcome,
): CoverageState {
  return updateRow(state, outcome, (row) => {
    if (row.sourceStatus !== 'readable') {
      throw new Error('session source is not readable')
    }
    if (row.processingStatus !== 'pending') {
      throw new Error('session processing outcome is already recorded')
    }
    if (outcome.status === 'not_required' && state.mode !== 'targeted') {
      throw new Error('complete coverage cannot skip readable session processing')
    }
    if (outcome.status !== 'processed' && outcome.relevant) {
      throw new Error('only processed sessions can be relevant')
    }
    return {
      ...row,
      processingStatus: outcome.status,
      relevant: outcome.status === 'processed' && outcome.relevant,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
    }
  })
}

export function finalizeCoverage(state: CoverageState): CoverageLedger {
  if (state.rows.some((row) => row.sourceStatus === 'pending')) {
    throw new Error('coverage has pending source outcomes')
  }
  if (state.rows.some((row) => row.processingStatus === 'pending')) {
    throw new Error('coverage has pending processing outcomes')
  }

  const rows = state.rows.map(finalizeRow)
  const countSource = (status: SessionSourceStatus) =>
    rows.filter((row) => row.sourceStatus === status).length
  const countProcessing = (status: SessionProcessingStatus) =>
    rows.filter((row) => row.processingStatus === status).length
  const readable = countSource('readable')
  const empty = countSource('empty')
  const unavailable = countSource('unavailable')
  const readFailed = countSource('failed')
  const processed = countProcessing('processed')
  const processFailed = countProcessing('failed')
  const status = coverageStatus(state.mode, {
    readable,
    empty,
    unavailable,
    readFailed,
    processFailed,
  })

  return {
    runId: state.runId,
    mode: state.mode,
    status,
    selected: rows.length,
    visited: rows.filter((row) => row.visited).length,
    readable,
    empty,
    unavailable,
    readFailed,
    processed,
    processFailed,
    relevant: rows.filter((row) => row.relevant).length,
    changedDuringRun: rows.filter((row) => row.sourceRevision?.changedDuringRun).length,
    rows,
  }
}

function finalizeRow(row: SessionCoverageStateRow): SessionCoverageRow {
  if (row.sourceStatus === 'pending') {
    throw new Error('coverage has pending source outcomes')
  }
  return {
    ...row,
    sourceStatus: row.sourceStatus,
    ...(row.sourceRevision ? { sourceRevision: { ...row.sourceRevision } } : {}),
  }
}

function coverageStatus(
  mode: SessionEvidenceMode,
  counts: {
    readable: number
    empty: number
    unavailable: number
    readFailed: number
    processFailed: number
  },
): CoverageStatus {
  const hasFailure = counts.unavailable > 0
    || counts.readFailed > 0
    || counts.processFailed > 0
  if (!hasFailure) return mode === 'complete' ? 'complete' : 'targeted'
  if (counts.readable === 0 && counts.empty === 0) return 'failed'
  return 'partial'
}

function updateRow(
  state: CoverageState,
  reference: SessionEvidenceReference,
  update: (row: SessionCoverageStateRow) => SessionCoverageStateRow,
): CoverageState {
  const key = referenceKey(reference)
  const index = state.rows.findIndex((row) => referenceKey({
    agent: row.agent,
    id: row.sessionId,
  }) === key)
  if (index < 0) throw new Error('session is not part of coverage selection')
  const rows = state.rows.map((row, rowIndex) => rowIndex === index ? update(row) : row)
  return { ...state, rows }
}

function referenceKey(reference: SessionEvidenceReference): string {
  return `${reference.agent}\0${reference.id}`
}
