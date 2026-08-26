export class RunCancelledError extends Error {
  readonly code = 'RUN_CANCELLED'

  constructor(message = 'Run cancelled') {
    super(message)
    this.name = 'RunCancelledError'
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RunCancelledError()
}

export function isRunCancelledError(error: unknown): error is RunCancelledError {
  return error instanceof RunCancelledError
    || (
      error instanceof Error
      && (
        error.name === 'AbortError'
        || (error as Error & { code?: string }).code === 'RUN_CANCELLED'
      )
    )
}
