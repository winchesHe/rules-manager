export function afterNextPaint<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve())).then(operation)
}
