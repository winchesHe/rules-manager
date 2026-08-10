import type { AgentName, ScanProgress, ScanSummary } from '../../core/src/types.js'
import {
  createRunId,
  isActiveRun,
  type RunCancelResult,
  type RunEnvelope,
  type RunState,
} from './background-run.js'

export type ScanWorkerMessage =
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'done'; summary: ScanSummary }
  | { type: 'cancelled'; summary?: ScanSummary }
  | { type: 'error'; message: string }

export interface ScanWorkerLike {
  on(event: 'message', listener: (message: ScanWorkerMessage) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  postMessage(message: { type: 'cancel' }): void
  terminate(): Promise<number>
}

export interface ScanStatus {
  running: boolean
  state: RunState
  runId?: string
  lastSeq: number
  progress?: ScanProgress
  progressByAgent?: Partial<Record<ScanProgress['agent'], ScanProgress>>
  summary?: ScanSummary
  error?: string
  selectedAgents?: AgentName[]
  sinceDays?: number
  completedAt?: string
  restored?: boolean
}

export interface ScanWorkerRequest {
  runId: string
  agents: AgentName[]
  sinceDays?: number
}

type ScanControllerEventData =
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'done'; summary: ScanSummary }
  | { type: 'cancelled'; summary?: ScanSummary }
  | { type: 'failed'; message: string }

export type ScanControllerEvent = ScanControllerEventData & RunEnvelope

export type ScanStartResult =
  | { started: true; runId: string }
  | { started: false; reason: 'already-running' }

interface ScanWaiter {
  resolve: (summary: ScanSummary) => void
  reject: (error: Error) => void
}

export class ScanController {
  private state: ScanStatus = { running: false, state: 'idle', lastSeq: 0 }
  private worker: ScanWorkerLike | undefined
  private readonly waiters = new Map<string, ScanWaiter[]>()

  constructor(
    private readonly createWorker: (request: ScanWorkerRequest) => ScanWorkerLike,
    private readonly emit: (event: ScanControllerEvent) => void,
  ) {}

  start(agents: AgentName[] = [], sinceDays?: number): ScanStartResult {
    if (isActiveRun(this.state.state)) {
      return { started: false, reason: 'already-running' }
    }

    const runId = createRunId()
    this.state = {
      running: true,
      state: 'running',
      runId,
      lastSeq: 0,
      selectedAgents: [...agents],
      sinceDays,
    }
    let worker: ScanWorkerLike
    try {
      worker = this.createWorker({ runId, agents, sinceDays })
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
      return { started: true, runId }
    }
    this.worker = worker

    worker.on('message', (message) => {
      if (worker !== this.worker) return
      if (message.type === 'progress') {
        this.state = {
          running: true,
          state: this.state.state,
          runId,
          lastSeq: this.state.lastSeq,
          progress: message.progress,
          progressByAgent: {
            ...this.state.progressByAgent,
            [message.progress.agent]: message.progress,
          },
          selectedAgents: this.state.selectedAgents,
          sinceDays: this.state.sinceDays,
        }
        this.emitWithSeq({ type: 'progress', progress: message.progress })
      } else if (message.type === 'done') {
        this.worker = undefined
        this.state = {
          running: false,
          state: 'completed',
          runId,
          lastSeq: this.state.lastSeq,
          progressByAgent: this.state.progressByAgent,
          summary: message.summary,
          selectedAgents: this.state.selectedAgents,
          sinceDays: this.state.sinceDays,
          completedAt: new Date().toISOString(),
        }
        this.emitWithSeq({ type: 'done', summary: message.summary })
        this.settleWaiters(runId)
      } else if (message.type === 'cancelled') {
        this.worker = undefined
        this.state = {
          running: false,
          state: 'cancelled',
          runId,
          lastSeq: this.state.lastSeq,
          progress: this.state.progress,
          progressByAgent: this.state.progressByAgent,
          summary: message.summary,
          selectedAgents: this.state.selectedAgents,
          sinceDays: this.state.sinceDays,
          completedAt: new Date().toISOString(),
        }
        this.emitWithSeq({ type: 'cancelled', summary: message.summary })
        this.settleWaiters(runId)
      } else {
        this.fail(message.message)
      }
    })
    worker.on('error', (error) => {
      if (worker === this.worker) this.fail(error.message)
    })
    worker.on('exit', (code) => {
      if (worker === this.worker) {
        this.fail(`Scan worker exited before completion (code ${code})`)
      }
    })

    return { started: true, runId }
  }

  async runToCompletion(
    agents: AgentName[] = [],
    sinceDays?: number,
  ): Promise<ScanSummary> {
    const active = this.status()
    if (isActiveRun(active.state) && active.runId) {
      const summary = await this.waitForCompletion(active.runId)
      if (sameScanScope(active, agents, sinceDays)) return summary
    }

    const started = this.start(agents, sinceDays)
    if (!started.started) return this.runToCompletion(agents, sinceDays)
    return this.waitForCompletion(started.runId)
  }

  status(): ScanStatus {
    return {
      ...this.state,
      selectedAgents: this.state.selectedAgents
        ? [...this.state.selectedAgents]
        : undefined,
      progressByAgent: this.state.progressByAgent
        ? { ...this.state.progressByAgent }
        : undefined,
    }
  }

  cancel(runId: string): RunCancelResult {
    if (!isActiveRun(this.state.state) || !this.worker || !this.state.runId) {
      return { accepted: false, reason: 'not-running' }
    }
    if (this.state.runId !== runId) {
      return { accepted: false, reason: 'stale-run' }
    }
    if (this.state.state === 'cancelling') {
      return { accepted: false, reason: 'already-cancelling' }
    }

    this.state = {
      ...this.state,
      running: true,
      state: 'cancelling',
    }
    this.worker.postMessage({ type: 'cancel' })
    return { accepted: true }
  }

  private fail(message: string): void {
    const runId = this.state.runId
    this.worker = undefined
    this.state = {
      running: false,
      state: 'failed',
      runId: this.state.runId,
      lastSeq: this.state.lastSeq,
      progressByAgent: this.state.progressByAgent,
      error: message,
      selectedAgents: this.state.selectedAgents,
      sinceDays: this.state.sinceDays,
    }
    this.emitWithSeq({ type: 'failed', message })
    if (runId) this.settleWaiters(runId)
  }

  private waitForCompletion(runId: string): Promise<ScanSummary> {
    const terminal = this.terminalResult(runId)
    if (terminal) return terminal
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(runId) ?? []
      waiters.push({ resolve, reject })
      this.waiters.set(runId, waiters)
    })
  }

  private terminalResult(runId: string): Promise<ScanSummary> | undefined {
    if (this.state.runId !== runId || isActiveRun(this.state.state)) return undefined
    if (this.state.state === 'completed' && this.state.summary) {
      return Promise.resolve(this.state.summary)
    }
    if (this.state.state === 'cancelled') {
      return Promise.reject(new Error('扫描已取消'))
    }
    if (this.state.state === 'failed') {
      return Promise.reject(new Error(this.state.error ?? '扫描失败'))
    }
    return undefined
  }

  private settleWaiters(runId: string): void {
    const waiters = this.waiters.get(runId)
    if (!waiters) return
    this.waiters.delete(runId)
    if (this.state.state === 'completed' && this.state.summary) {
      for (const waiter of waiters) waiter.resolve(this.state.summary)
      return
    }
    const message = this.state.state === 'cancelled'
      ? '扫描已取消'
      : this.state.error ?? '扫描失败'
    for (const waiter of waiters) waiter.reject(new Error(message))
  }

  private emitWithSeq(
    event: ScanControllerEventData,
  ): void {
    const runId = this.state.runId
    if (!runId) return
    const seq = this.state.lastSeq + 1
    this.state = { ...this.state, lastSeq: seq }
    this.emit({
      ...event,
      runId,
      seq,
      at: new Date().toISOString(),
    } as ScanControllerEvent)
  }
}

function sameScanScope(
  status: ScanStatus,
  agents: AgentName[],
  sinceDays?: number,
): boolean {
  if (status.sinceDays !== sinceDays) return false
  const currentAgents = [...(status.selectedAgents ?? [])].sort()
  const requestedAgents = [...agents].sort()
  return currentAgents.length === requestedAgents.length
    && currentAgents.every((agent, index) => agent === requestedAgents[index])
}
