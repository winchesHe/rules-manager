export interface MaximizableWindow {
  isFullScreen: () => boolean
  isMaximized: () => boolean
  maximize: () => void
  unmaximize: () => void
}

export type WindowMaximizeResult = 'maximized' | 'restored' | 'fullscreen'

export function toggleWindowMaximize(window: MaximizableWindow): WindowMaximizeResult {
  if (window.isFullScreen()) return 'fullscreen'
  if (window.isMaximized()) {
    window.unmaximize()
    return 'restored'
  }
  window.maximize()
  return 'maximized'
}
