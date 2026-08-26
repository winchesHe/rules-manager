import { randomUUID } from 'node:crypto'

export type RunState =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'interrupted'

export interface RunEnvelope {
  runId: string
  seq: number
  at: string
}

export type RunCancelResult =
  | { accepted: true }
  | { accepted: false; reason: 'not-running' | 'already-cancelling' | 'stale-run' }

export function createRunId(): string {
  return randomUUID()
}

export function isActiveRun(state: RunState): boolean {
  return state === 'running' || state === 'cancelling'
}
