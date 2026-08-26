interface WindowActionsTarget {
  close(): void
  minimize(): void
}

export function closeWindow(window: WindowActionsTarget): 'closing' {
  window.close()
  return 'closing'
}

export function minimizeWindow(window: WindowActionsTarget): 'minimized' {
  window.minimize()
  return 'minimized'
}
