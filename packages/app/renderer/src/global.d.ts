export {}

declare global {
  interface Window {
    api: {
      invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
      onEvent(channel: string, callback: (...args: unknown[]) => void): void
      offEvent(channel: string, callback: (...args: unknown[]) => void): void
    }
  }
}
