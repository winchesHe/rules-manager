import { app, BrowserWindow } from 'electron'
import { ChatCompletionBadge } from './chat-completion-badge.js'

const completionBadge = new ChatCompletionBadge({
  isAppFocused: () => BrowserWindow.getAllWindows().some((window) =>
    !window.isDestroyed() && window.isFocused(),
  ),
  setBadgeCount: (count) => {
    app.setBadgeCount(count)
  },
})

export function recordChatCompletion(): void {
  completionBadge.recordCompletion()
}

export function clearChatCompletionBadge(): void {
  completionBadge.clear()
}
