import { describe, expect, it } from '@jest/globals'
import {
  readStoredContextPaneOpen,
  writeStoredContextPaneOpen,
} from '../renderer/src/views/chat-layout-preference.js'

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('chat layout preference', () => {
  it('没有偏好时默认展开 Context Pane', () => {
    expect(readStoredContextPaneOpen(new MemoryStorage())).toBe(true)
  })

  it('只接受明确的 true / false', () => {
    const storage = new MemoryStorage()
    storage.values.set('memory-manager.chat.context-pane-open', 'false')
    expect(readStoredContextPaneOpen(storage)).toBe(false)
    storage.values.set('memory-manager.chat.context-pane-open', 'invalid')
    expect(readStoredContextPaneOpen(storage)).toBe(true)
  })

  it('保存失败不影响当前布局切换', () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error('denied') },
    }
    expect(() => writeStoredContextPaneOpen(storage, false)).not.toThrow()
  })

  it('保存展开状态', () => {
    const storage = new MemoryStorage()
    writeStoredContextPaneOpen(storage, false)
    expect(storage.values.get('memory-manager.chat.context-pane-open')).toBe('false')
  })
})
