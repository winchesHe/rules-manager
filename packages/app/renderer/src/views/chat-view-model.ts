import type {
  ChatMessage,
  GenerationChatThread,
  NativeSessionReference,
  ProviderSnapshot,
  ProjectGenerationResponse,
} from '../types'

export function createProviderSnapshotSync(
  apply: (snapshot: ProviderSnapshot) => void,
): {
  receiveInitial(snapshot: ProviderSnapshot): void
  receiveUpdate(value: unknown): void
  stop(): void
} {
  let active = true
  let receivedUpdate = false
  return {
    receiveInitial(snapshot) {
      if (active && !receivedUpdate) apply(snapshot)
    },
    receiveUpdate(value) {
      if (!active || !isProviderSnapshot(value)) return
      receivedUpdate = true
      apply(value)
    },
    stop() {
      active = false
    },
  }
}

export function assistantTurnStartedAt(
  messages: ChatMessage[],
  assistantIndex: number,
): string | undefined {
  for (let index = assistantIndex - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return messages[index].createdAt
  }
  return messages[assistantIndex]?.createdAt
}

export function canRegenerate(status: GenerationChatThread['status']): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

export function visibleProjectResponses(
  status: GenerationChatThread['status'],
  responses: ProjectGenerationResponse[],
): ProjectGenerationResponse[] {
  if (status === 'completed') return responses
  if (status === 'failed') {
    return responses.filter((response) => response.status !== 'failed')
  }
  return []
}

export function mergeTimelineActivities(
  activities: GenerationChatThread['activities'],
): GenerationChatThread['activities'] {
  const merged = new Map<string, GenerationChatThread['activities'][number]>()
  for (const activity of activities) {
    const key = activity.id ?? `${activity.kind}-${activity.seq}`
    const existing = merged.get(key)
    merged.set(key, existing
      ? {
          ...existing,
          ...activity,
          seq: existing.seq,
          at: existing.at,
        }
      : activity)
  }
  return [...merged.values()]
}

export function formatElapsed(startedAt: string, now = Date.now()): string {
  const started = Date.parse(startedAt)
  const totalSeconds = Number.isFinite(started)
    ? Math.max(0, Math.floor((now - started) / 1_000))
    : 0
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function shouldFollowStream({
  scrollTop,
  clientHeight,
  scrollHeight,
  threshold = 72,
}: {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  threshold?: number
}): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

export function shouldSubmitComposer({
  isComposing,
  key,
  keyCode,
  shiftKey,
}: {
  isComposing: boolean
  key: string
  keyCode: number
  shiftKey: boolean
}): boolean {
  return key === 'Enter' && !shiftKey && !isComposing && keyCode !== 229
}

export function virtualWindowRange({
  itemCount,
  overscan,
  rowHeight,
  scrollTop,
  viewportHeight,
}: {
  itemCount: number
  overscan: number
  rowHeight: number
  scrollTop: number
  viewportHeight: number
}): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(
    itemCount,
    Math.ceil((scrollTop + Math.max(0, viewportHeight)) / rowHeight) + overscan,
  )
  return { start, end }
}

export function toggleAvailableSessionSelection(
  selected: NativeSessionReference[],
  available: NativeSessionReference[],
): NativeSessionReference[] {
  const availableKeys = new Set(available.map(sessionReferenceKey))
  const selectedKeys = new Set(selected.map(sessionReferenceKey))
  const allAvailableSelected = available.length > 0
    && available.every((reference) => selectedKeys.has(sessionReferenceKey(reference)))
  if (allAvailableSelected) {
    return selected.filter((reference) => !availableKeys.has(sessionReferenceKey(reference)))
  }
  const merged = new Map(selected.map((reference) => [sessionReferenceKey(reference), reference]))
  for (const reference of available) merged.set(sessionReferenceKey(reference), reference)
  return [...merged.values()]
}

export function countSelectedSessionReferences(
  selected: NativeSessionReference[],
  scope: NativeSessionReference[],
): number {
  const selectedKeys = new Set(selected.map(sessionReferenceKey))
  let count = 0
  for (const reference of scope) {
    if (selectedKeys.has(sessionReferenceKey(reference))) count++
  }
  return count
}

function sessionReferenceKey(reference: NativeSessionReference): string {
  return `${reference.agent}\0${reference.id}`
}

function isProviderSnapshot(value: unknown): value is ProviderSnapshot {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray((value as { entries?: unknown }).entries)
    && typeof (value as { refreshing?: unknown }).refreshing === 'boolean',
  )
}
