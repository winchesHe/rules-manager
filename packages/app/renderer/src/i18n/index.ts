import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import commonEn from './locales/en-US/common.json'
import navigationEn from './locales/en-US/navigation.json'
import projectsEn from './locales/en-US/projects.json'
import rulesEn from './locales/en-US/rules.json'
import scanEn from './locales/en-US/scan.json'
import settingsEn from './locales/en-US/settings.json'
import commonZh from './locales/zh-CN/common.json'
import navigationZh from './locales/zh-CN/navigation.json'
import projectsZh from './locales/zh-CN/projects.json'
import rulesZh from './locales/zh-CN/rules.json'
import scanZh from './locales/zh-CN/scan.json'
import settingsZh from './locales/zh-CN/settings.json'
import {
  defaultLocale,
  isAppLocale,
  readStoredLocale,
  tryWriteStoredLocale,
  type AppLocale,
} from './locale'

const resources = {
  'zh-CN': {
    common: commonZh,
    navigation: navigationZh,
    projects: projectsZh,
    rules: rulesZh,
    scan: scanZh,
    settings: settingsZh,
  },
  'en-US': {
    common: commonEn,
    navigation: navigationEn,
    projects: projectsEn,
    rules: rulesEn,
    scan: scanEn,
    settings: settingsEn,
  },
} as const

export function initializeI18n(storage: Storage = window.localStorage): AppLocale {
  const locale = readStoredLocale(storage)
  if (!i18n.isInitialized) {
    void i18n.use(initReactI18next).init({
      resources,
      lng: locale,
      fallbackLng: defaultLocale,
      supportedLngs: ['zh-CN', 'en-US'],
      defaultNS: 'common',
      initAsync: false,
      interpolation: { escapeValue: false },
      returnNull: false,
    })
  }
  applyDocumentLocale(locale)
  return locale
}

export async function changeAppLocale(
  value: unknown,
  storage: Storage = window.localStorage,
): Promise<{ locale: AppLocale; persisted: boolean }> {
  const locale = isAppLocale(value) ? value : defaultLocale
  await i18n.changeLanguage(locale)
  applyDocumentLocale(locale)
  return {
    locale,
    persisted: tryWriteStoredLocale(storage, locale),
  }
}

export function currentLocale(): AppLocale {
  return isAppLocale(i18n.resolvedLanguage) ? i18n.resolvedLanguage : defaultLocale
}

function applyDocumentLocale(locale: AppLocale): void {
  document.documentElement.lang = locale
  document.documentElement.dir = 'ltr'
}

export { default as i18n } from 'i18next'
export type { AppLocale } from './locale'
