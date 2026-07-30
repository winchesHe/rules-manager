export const supportedLocales = ['zh-CN', 'en-US'] as const
export type AppLocale = (typeof supportedLocales)[number]

export const defaultLocale: AppLocale = 'zh-CN'
export const localeStorageKey = 'memory-manager.locale'

export function isAppLocale(value: unknown): value is AppLocale {
  return supportedLocales.includes(value as AppLocale)
}

export function readStoredLocale(storage: Pick<Storage, 'getItem'>): AppLocale {
  try {
    const stored = storage.getItem(localeStorageKey)
    return isAppLocale(stored) ? stored : defaultLocale
  } catch {
    return defaultLocale
  }
}

export function writeStoredLocale(
  storage: Pick<Storage, 'setItem'>,
  locale: AppLocale,
): void {
  storage.setItem(localeStorageKey, locale)
}

export function tryWriteStoredLocale(
  storage: Pick<Storage, 'setItem'>,
  locale: AppLocale,
): boolean {
  try {
    writeStoredLocale(storage, locale)
    return true
  } catch {
    return false
  }
}
