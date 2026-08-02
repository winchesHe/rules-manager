import type {
  NativeChatEvent,
  NativeTurnTimelineItem,
} from './chat-runtime.js'

const MAX_THINKING_LENGTH = 16_000

export function mergeNativeTimelineEvent(
  current: NativeTurnTimelineItem[],
  event: NativeChatEvent,
): NativeTurnTimelineItem[] {
  if (event.type === 'usage') return current
  if (event.type === 'tool_activity') {
    return upsertTimelineItem(current, {
      type: 'tool', itemId: event.activity.itemId, activity: event.activity,
    })
  }
  const existing = current.find((item) =>
    item.type === (event.type === 'assistant_delta' ? 'assistant' : 'thinking')
    && item.itemId === event.itemId,
  )
  const previousContent = existing?.type === 'assistant' || existing?.type === 'thinking'
    ? existing.content
    : ''
  const content = event.content ?? `${previousContent}${event.text}`
  if (event.type === 'assistant_delta') {
    return upsertTimelineItem(current, {
      type: 'assistant', itemId: event.itemId, content,
    })
  }
  return upsertTimelineItem(current, {
    type: 'thinking',
    itemId: event.itemId,
    content: content.slice(0, MAX_THINKING_LENGTH),
    status: event.status ?? 'running',
  })
}

export function completeNativeTimeline(
  timeline: NativeTurnTimelineItem[],
  fallbackContent: string,
): NativeTurnTimelineItem[] {
  const completed = timeline.map((item) => item.type === 'thinking'
    ? { ...item, status: 'completed' as const }
    : item)
  if (completed.some((item) => item.type === 'assistant') || !fallbackContent) return completed
  return [...completed, { type: 'assistant', itemId: 'result', content: fallbackContent }]
}

function upsertTimelineItem(
  current: NativeTurnTimelineItem[],
  incoming: NativeTurnTimelineItem,
): NativeTurnTimelineItem[] {
  const index = current.findIndex((item) =>
    item.type === incoming.type && item.itemId === incoming.itemId,
  )
  if (index < 0) return [...current, incoming]
  return current.map((item, itemIndex) => itemIndex === index ? incoming : item)
}
