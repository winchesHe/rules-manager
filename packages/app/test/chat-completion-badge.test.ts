import { describe, expect, it } from '@jest/globals'
import { ChatCompletionBadge } from '../main/chat-completion-badge.js'

describe('ChatCompletionBadge', () => {
  it('应用在后台时按完成轮次累计，并在清零后重新从 1 开始', () => {
    const applied: number[] = []
    const badge = new ChatCompletionBadge({
      isAppFocused: () => false,
      setBadgeCount: (count) => { applied.push(count) },
    })

    expect(badge.recordCompletion()).toBe(1)
    expect(badge.recordCompletion()).toBe(2)
    expect(applied).toEqual([1, 2])

    badge.clear()
    expect(badge.count()).toBe(0)
    expect(applied).toEqual([1, 2, 0])
    expect(badge.recordCompletion()).toBe(1)
    expect(applied).toEqual([1, 2, 0, 1])
  })

  it('应用在前台时不产生未读角标', () => {
    const applied: number[] = []
    const badge = new ChatCompletionBadge({
      isAppFocused: () => true,
      setBadgeCount: (count) => { applied.push(count) },
    })

    expect(badge.recordCompletion()).toBe(0)
    expect(badge.count()).toBe(0)
    expect(applied).toEqual([])
  })

  it('系统角标 API 失败时仍保留计数且不抛错', () => {
    const badge = new ChatCompletionBadge({
      isAppFocused: () => false,
      setBadgeCount: () => { throw new Error('unsupported') },
    })

    expect(() => badge.recordCompletion()).not.toThrow()
    expect(badge.count()).toBe(1)
    expect(() => badge.clear()).not.toThrow()
    expect(badge.count()).toBe(0)
  })
})
