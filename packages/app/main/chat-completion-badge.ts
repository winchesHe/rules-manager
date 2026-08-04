export interface ChatCompletionBadgeOptions {
  isAppFocused: () => boolean
  setBadgeCount: (count: number) => void
}

export class ChatCompletionBadge {
  private unreadCount = 0

  constructor(private readonly options: ChatCompletionBadgeOptions) {}

  recordCompletion(): number {
    if (this.options.isAppFocused()) return this.unreadCount
    this.unreadCount += 1
    this.applyBadgeCount()
    return this.unreadCount
  }

  clear(): void {
    if (this.unreadCount === 0) return
    this.unreadCount = 0
    this.applyBadgeCount()
  }

  count(): number {
    return this.unreadCount
  }

  private applyBadgeCount(): void {
    try {
      this.options.setBadgeCount(this.unreadCount)
    } catch {
      // 系统角标失败不能反向改变已经成功完成的 Chat Turn。
    }
  }
}
