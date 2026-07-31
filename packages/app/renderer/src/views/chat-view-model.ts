import type {
  ChatThread,
  ProjectGenerationResponse,
} from '../types'

export function canRegenerate(status: ChatThread['status']): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

export function visibleProjectResponses(
  status: ChatThread['status'],
  responses: ProjectGenerationResponse[],
): ProjectGenerationResponse[] {
  if (status === 'completed') return responses
  if (status === 'failed') {
    return responses.filter((response) => response.status !== 'failed')
  }
  return []
}

export function mergeTimelineActivities(
  activities: ChatThread['activities'],
): ChatThread['activities'] {
  const merged = new Map<string, ChatThread['activities'][number]>()
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
