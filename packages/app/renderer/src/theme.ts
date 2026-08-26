export const supportedThemes = ['dark', 'light'] as const
export type ThemeMode = (typeof supportedThemes)[number]

export const defaultTheme: ThemeMode = 'dark'
export const themeStorageKey = 'memory-manager.theme'

type ThemeRoot = {
  classList: Pick<DOMTokenList, 'add' | 'remove'>
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return supportedThemes.includes(value as ThemeMode)
}

export function readStoredTheme(storage: Pick<Storage, 'getItem'>): ThemeMode {
  try {
    const stored = storage.getItem(themeStorageKey)
    return isThemeMode(stored) ? stored : defaultTheme
  } catch {
    return defaultTheme
  }
}

export function writeStoredTheme(
  storage: Pick<Storage, 'setItem'>,
  theme: ThemeMode,
): void {
  storage.setItem(themeStorageKey, theme)
}

export function tryWriteStoredTheme(
  storage: Pick<Storage, 'setItem'>,
  theme: ThemeMode,
): boolean {
  try {
    writeStoredTheme(storage, theme)
    return true
  } catch {
    return false
  }
}

export function applyTheme(
  theme: ThemeMode,
  root: ThemeRoot = document.documentElement,
): void {
  root.classList.remove('dark', 'light')
  root.classList.add(theme)
}

export function initializeTheme(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
  root: ThemeRoot = document.documentElement,
): ThemeMode {
  const theme = readStoredTheme(storage)
  applyTheme(theme, root)
  return theme
}

export function changeAppTheme(
  theme: ThemeMode,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
  root: ThemeRoot = document.documentElement,
): { theme: ThemeMode; persisted: boolean } {
  applyTheme(theme, root)
  return {
    theme,
    persisted: tryWriteStoredTheme(storage, theme),
  }
}
