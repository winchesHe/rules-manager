import type {
  NativeChatEvent,
  NativeToolActivity,
  NativeTurnTimelineItem,
} from '../types'

export type NativeTurnTimelineDisplayItem =
  | Exclude<NativeTurnTimelineItem, { type: 'tool' }>
  | { type: 'tool-group'; itemId: string; activities: NativeToolActivity[] }

export interface ToolActivityCounts {
  read: number
  search: number
  shell: number
  tool: number
}

export function shouldShowNativeChatStop(
  isSending: boolean,
  thread: { kind: string; status: string } | null | undefined,
): boolean {
  return isSending || (thread?.kind === 'native-chat' && thread.status === 'running')
}

export function groupNativeTurnTimeline(
  timeline: NativeTurnTimelineItem[],
): NativeTurnTimelineDisplayItem[] {
  const grouped: NativeTurnTimelineDisplayItem[] = []

  for (const item of timeline) {
    if (item.type !== 'tool') {
      grouped.push(item)
      continue
    }

    const previous = grouped.at(-1)
    if (previous?.type === 'tool-group') {
      previous.activities.push(item.activity)
      continue
    }

    grouped.push({
      type: 'tool-group',
      itemId: item.itemId,
      activities: [item.activity],
    })
  }

  return grouped
}

export function toolActivityCounts(
  activities: NativeToolActivity[],
): ToolActivityCounts {
  return activities.reduce<ToolActivityCounts>((counts, activity) => {
    const kind = activity.kind === 'thinking' ? 'tool' : activity.kind
    counts[kind] += 1
    return counts
  }, { read: 0, search: 0, shell: 0, tool: 0 })
}

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
