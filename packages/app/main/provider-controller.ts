import type {
  ProviderDiagnostic,
  ProviderSnapshotEntry,
} from '../../core/src/provider-catalog.js'
import type { LlmProvider } from '../../core/src/config.js'

export type ProviderWorkerMessage =
  | { type: 'done'; entries: ProviderSnapshotEntry[] }
  | { type: 'diagnostic'; diagnostic: ProviderDiagnostic }
  | { type: 'error'; message: string }

export interface ProviderWorkerLike {
  on(event: 'message', listener: (message: ProviderWorkerMessage) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number>
}

export interface ProviderSnapshot {
  entries: ProviderSnapshotEntry[]
  refreshing: boolean
  diagnosing?: LlmProvider
  diagnostics?: Partial<Record<LlmProvider, ProviderDiagnostic>>
  error?: string
}

export type ProviderControllerEvent =
  | { type: 'updated'; snapshot: ProviderSnapshot }
  | { type: 'diagnostic'; diagnostic: ProviderDiagnostic }
  | { type: 'failed'; message: string }

export interface ProviderWorkerRequest {
  operation: 'refresh' | 'diagnostic'
  provider?: LlmProvider
}

type WorkerFactory = (request: ProviderWorkerRequest) => ProviderWorkerLike

export class ProviderController {
  private state: ProviderSnapshot = { entries: [], refreshing: false }
  private worker: ProviderWorkerLike | undefined
  private targetProvider: LlmProvider | undefined

  constructor(
    private createWorker: WorkerFactory,
    private readonly emit: (event: ProviderControllerEvent) => void,
  ) {}

  setWorkerFactory(factory: WorkerFactory): void {
    this.createWorker = factory
  }

  refresh(provider?: LlmProvider):
    | { started: true }
    | { started: false; reason: 'already-refreshing' } {
    if (this.state.refreshing) {
      return { started: false, reason: 'already-refreshing' }
    }

    this.state = { entries: this.state.entries, refreshing: true }
    let worker: ProviderWorkerLike
    try {
      worker = this.createWorker({ operation: 'refresh', provider })
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
      return { started: true }
    }
    this.worker = worker
    this.targetProvider = provider
    worker.on('message', (message) => {
      if (worker !== this.worker) return
      if (message.type === 'done') {
        this.worker = undefined
        const entries = this.targetProvider
          ? mergeEntries(this.state.entries, message.entries)
          : message.entries
        this.targetProvider = undefined
        this.state = {
          entries,
          refreshing: false,
          diagnostics: this.state.diagnostics,
        }
        this.emit({ type: 'updated', snapshot: this.snapshot() })
      } else if (message.type === 'diagnostic') {
        this.worker = undefined
        this.targetProvider = undefined
        this.state = {
          ...this.state,
          refreshing: false,
          diagnosing: undefined,
          diagnostics: {
            ...this.state.diagnostics,
            [message.diagnostic.provider]: message.diagnostic,
          },
        }
        this.emit({ type: 'diagnostic', diagnostic: message.diagnostic })
      } else {
        this.fail(message.message)
      }
    })
    worker.on('error', (error) => {
      if (worker === this.worker) this.fail(error.message)
    })
    worker.on('exit', (code) => {
      if (worker === this.worker) {
        this.fail(`Provider worker exited before completion (code ${code})`)
      }
    })
    return { started: true }
  }

  diagnose(provider: LlmProvider):
    | { started: true }
    | { started: false; reason: 'provider-worker-busy' } {
    if (this.worker) return { started: false, reason: 'provider-worker-busy' }
    this.state = {
      ...this.state,
      diagnosing: provider,
      error: undefined,
    }
    let worker: ProviderWorkerLike
    try {
      worker = this.createWorker({ operation: 'diagnostic', provider })
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
      return { started: true }
    }
    this.worker = worker
    this.bindWorker(worker)
    return { started: true }
  }

  snapshot(): ProviderSnapshot {
    return {
      ...this.state,
      entries: this.state.entries.map((entry) => ({
        ...entry,
        models: entry.models.map((model) => ({ ...model })),
      })),
      diagnostics: this.state.diagnostics
        ? { ...this.state.diagnostics }
        : undefined,
    }
  }

  private bindWorker(worker: ProviderWorkerLike): void {
    worker.on('message', (message) => {
      if (worker !== this.worker) return
      if (message.type === 'diagnostic') {
        this.worker = undefined
        this.state = {
          ...this.state,
          diagnosing: undefined,
          diagnostics: {
            ...this.state.diagnostics,
            [message.diagnostic.provider]: message.diagnostic,
          },
        }
        this.emit({ type: 'diagnostic', diagnostic: message.diagnostic })
      } else if (message.type === 'error') {
        this.fail(message.message)
      }
    })
    worker.on('error', (error) => {
      if (worker === this.worker) this.fail(error.message)
    })
    worker.on('exit', (code) => {
      if (worker === this.worker) {
        this.fail(`Provider worker exited before completion (code ${code})`)
      }
    })
  }

  private fail(message: string): void {
    this.worker = undefined
    this.targetProvider = undefined
    this.state = {
      entries: this.state.entries,
      refreshing: false,
      diagnosing: undefined,
      diagnostics: this.state.diagnostics,
      error: message,
    }
    this.emit({ type: 'failed', message })
  }
}

function mergeEntries(
  current: ProviderSnapshotEntry[],
  incoming: ProviderSnapshotEntry[],
): ProviderSnapshotEntry[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]))
  for (const entry of incoming) byId.set(entry.id, entry)
  return ['claude', 'codex']
    .map((id) => byId.get(id as LlmProvider))
    .filter((entry): entry is ProviderSnapshotEntry => Boolean(entry))
}
