import type { AppLocale } from './locale'

export function formatDate(
  value: Date | string | number,
  locale: AppLocale,
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(toDate(value))
}

export function formatDateTime(
  value: Date | string | number,
  locale: AppLocale,
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(toDate(value))
}

export function formatNumber(value: number, locale: AppLocale): string {
  return new Intl.NumberFormat(locale).format(value)
}

export function formatBytes(value: number, locale: AppLocale): string {
  if (!Number.isFinite(value) || value <= 0) return `0 ${unit('B', locale)}`
  const units = ['B', 'KB', 'MB', 'GB'] as const
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / 1024 ** exponent
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: exponent === 0 ? 0 : 1 }).format(amount)} ${unit(units[exponent]!, locale)}`
}

function unit(value: 'B' | 'KB' | 'MB' | 'GB', locale: AppLocale): string {
  if (locale === 'zh-CN') {
    return { B: '字节', KB: 'KB', MB: 'MB', GB: 'GB' }[value]
  }
  return value
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value)
}
