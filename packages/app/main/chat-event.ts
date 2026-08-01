import type { NativeToolActivity } from './chat-runtime.js'

const MAX_SUMMARY_LENGTH = 240

export function safeToolActivity(input: {
  itemId: unknown
  name: unknown
  providerType?: unknown
  status: NativeToolActivity['status']
  input?: unknown
  item?: unknown
}): NativeToolActivity | null {
  const itemId = stringValue(input.itemId)
  const name = stringValue(input.name) ?? stringValue(input.providerType) ?? 'Tool'
  if (!itemId) return null
  const source = recordValue(input.input)
  const item = recordValue(input.item)
  const summary = firstString([
    source.file_path,
    source.path,
    source.pattern,
    source.query,
    source.command,
    item.filePath,
    item.path,
    item.query,
    item.command,
  ])
  return {
    itemId,
    kind: toolKind(name, input.providerType),
    name: displayName(name),
    status: input.status,
    ...(summary ? { summary: truncate(summary) } : {}),
  }
}

function toolKind(name: string, providerType: unknown): NativeToolActivity['kind'] {
  const normalized = `${name} ${stringValue(providerType) ?? ''}`.toLowerCase()
  if (normalized.includes('read') || normalized.includes('file')) return 'read'
  if (normalized.includes('search') || normalized.includes('grep')) return 'search'
  if (normalized.includes('bash') || normalized.includes('shell') || normalized.includes('command')) return 'shell'
  if (normalized.includes('think') || normalized.includes('reason')) return 'thinking'
  return 'tool'
}

function displayName(name: string): string {
  if (name.toLowerCase() === 'commandexecution') return 'Command'
  return name
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value)
    if (text) return text
    if (Array.isArray(value)) {
      const joined = value.filter((item): item is string => typeof item === 'string').join(' ')
      if (joined) return joined
    }
  }
  return null
}

function truncate(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= MAX_SUMMARY_LENGTH
    ? compact
    : `${compact.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
