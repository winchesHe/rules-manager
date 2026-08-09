import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@jest/globals'
import {
  applyTheme,
  changeAppTheme,
  defaultTheme,
  initializeTheme,
  readStoredTheme,
  themeStorageKey,
  tryWriteStoredTheme,
  writeStoredTheme,
} from '../renderer/src/theme.js'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = path.join(appRoot, 'renderer/src')

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

class MemoryClassList {
  private readonly values = new Set<string>()

  add(...tokens: string[]): void {
    tokens.forEach((token) => this.values.add(token))
  }

  contains(token: string): boolean {
    return this.values.has(token)
  }

  remove(...tokens: string[]): void {
    tokens.forEach((token) => this.values.delete(token))
  }
}

describe('APP theme', () => {
  it('无有效偏好时回退 dark，并读写合法偏好', () => {
    const storage = new MemoryStorage()
    expect(defaultTheme).toBe('dark')
    expect(readStoredTheme(storage)).toBe('dark')

    storage.setItem(themeStorageKey, 'light')
    expect(readStoredTheme(storage)).toBe('light')

    storage.setItem(themeStorageKey, 'system')
    expect(readStoredTheme(storage)).toBe('dark')

    writeStoredTheme(storage, 'dark')
    expect(storage.getItem(themeStorageKey)).toBe('dark')
  })

  it('存储读写失败时安全回退且不阻断当前会话', () => {
    expect(
      readStoredTheme({
        getItem: () => {
          throw new Error('unavailable')
        },
      }),
    ).toBe('dark')
    expect(
      tryWriteStoredTheme(
        {
          setItem: () => {
            throw new Error('quota exceeded')
          },
        },
        'light',
      ),
    ).toBe(false)
  })

  it('应用主题时只保留目标 class，初始化恢复已保存主题', () => {
    const classList = new MemoryClassList()
    const root = { classList }
    classList.add('dark', 'app-root')

    applyTheme('light', root)
    expect(classList.contains('dark')).toBe(false)
    expect(classList.contains('light')).toBe(true)
    expect(classList.contains('app-root')).toBe(true)

    const storage = new MemoryStorage()
    storage.setItem(themeStorageKey, 'dark')
    expect(initializeTheme(storage, root)).toBe('dark')
    expect(classList.contains('dark')).toBe(true)
    expect(classList.contains('light')).toBe(false)
  })

  it('切换主题会同时更新页面并保存偏好', () => {
    const classList = new MemoryClassList()
    const storage = new MemoryStorage()

    expect(changeAppTheme('light', storage, { classList })).toEqual({
      persisted: true,
      theme: 'light',
    })
    expect(classList.contains('light')).toBe(true)
    expect(storage.getItem(themeStorageKey)).toBe('light')
  })

  it('React 挂载前恢复主题，切换操作会持久化', () => {
    const main = fs.readFileSync(path.join(rendererRoot, 'main.tsx'), 'utf8')
    const app = fs.readFileSync(path.join(rendererRoot, 'App.tsx'), 'utf8')
    expect(main).toContain('initializeTheme')
    expect(main.indexOf('initializeTheme()')).toBeLessThan(main.indexOf('createRoot('))
    expect(app).toContain('readStoredTheme')
    expect(app).toContain('changeAppTheme')
  })

  it('主题 token 符合深浅黑白灰契约', () => {
    const styles = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8')
    const dark = styles.match(/:root\.dark\s*{([\s\S]*?)\n}/)?.[1]
    const light = styles.match(/:root\.light\s*{([\s\S]*?)\n}/)?.[1]
    expect(dark).toContain('--theme-background: 0 0% 4%')
    expect(dark).toContain('--theme-sidebar: 0 0% 6%')
    expect(dark).toContain('--theme-surface: 0 0% 8%')
    expect(dark).toContain('--theme-primary: 0 0% 100%')
    expect(dark).toContain('--theme-primary-foreground: 0 0% 0%')
    expect(light).toContain('--theme-background: 0 0% 97%')
    expect(light).toContain('--theme-sidebar: 0 0% 94%')
    expect(light).toContain('--theme-primary: 0 0% 7%')
    expect(light).not.toMatch(/214|217|blue/i)
  })
})
