const CONTEXT_PANE_OPEN_KEY = 'memory-manager.chat.context-pane-open'

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

export function readStoredContextPaneOpen(storage: LayoutStorage): boolean {
  try {
    const value = storage.getItem(CONTEXT_PANE_OPEN_KEY)
    if (value === 'false') return false
    return true
  } catch {
    return true
  }
}

export function writeStoredContextPaneOpen(
  storage: LayoutStorage,
  open: boolean,
): void {
  try {
    storage.setItem(CONTEXT_PANE_OPEN_KEY, String(open))
  } catch {
    // Layout preference failures must not block the current Chat session.
  }
}
