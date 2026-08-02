import type {
  NativeChatEvent,
  NativeTurnTimelineItem,
} from '../types'

export function mergeLiveTimeline(
  current: NativeTurnTimelineItem[],
  event: NativeChatEvent,
): NativeTurnTimelineItem[] {
  if (event.type === 'usage') return current
  const incoming = timelineItemFromEvent(current, event)
  const index = current.findIndex((item) =>
    item.type === incoming.type && item.itemId === incoming.itemId,
  )
  if (index < 0) return [...current, incoming]
  return current.map((item, itemIndex) => itemIndex === index ? incoming : item)
}

function timelineItemFromEvent(
  current: NativeTurnTimelineItem[],
  event: Exclude<NativeChatEvent, { type: 'usage' }>,
): NativeTurnTimelineItem {
  if (event.type === 'tool_activity') {
    return { type: 'tool', itemId: event.activity.itemId, activity: event.activity }
  }
  const itemType = event.type === 'assistant_delta' ? 'assistant' : 'thinking'
  const content = event.content
    ?? `${timelineContent(current, itemType, event.itemId)}${event.text}`
  if (event.type === 'assistant_delta') {
    return { type: 'assistant', itemId: event.itemId, content }
  }
  return {
    type: 'thinking', itemId: event.itemId, content,
    status: event.status ?? 'running',
  }
}

function timelineContent(
  timeline: NativeTurnTimelineItem[],
  type: 'assistant' | 'thinking',
  itemId: string,
): string {
  const item = timeline.find((current) => current.type === type && current.itemId === itemId)
  return item?.type === 'assistant' || item?.type === 'thinking' ? item.content : ''
}
