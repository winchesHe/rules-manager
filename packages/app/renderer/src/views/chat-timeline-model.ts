import type {
  NativeChatEvent,
  NativeToolActivity,
  NativeTurnTimelineItem,
} from '../types'

export type NativeTurnTimelineDisplayItem =
  | NativeTurnTimelineItem
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

export function shouldApplySelectedThreadRead(input: {
  requestVersion: number
  latestVersion: number
  requestedId: string
  selectedId: string | null
}): boolean {
  return input.requestVersion === input.latestVersion
    && input.requestedId === input.selectedId
}

export function normalizeThinkingMarkdown(content: string): string {
  return content.replace(/(\S)\*{4}(?=\S)/g, '$1**\n\n**')
}

export function groupNativeTurnTimeline(
  timeline: NativeTurnTimelineItem[],
): NativeTurnTimelineDisplayItem[] {
  const grouped: NativeTurnTimelineDisplayItem[] = []
  let pendingTools: Extract<NativeTurnTimelineItem, { type: 'tool' }>[] = []

  const flushTools = (): void => {
    if (pendingTools.length === 1) {
      grouped.push(pendingTools[0])
    } else if (pendingTools.length > 1) {
      grouped.push({
        type: 'tool-group',
        itemId: pendingTools[0].itemId,
        activities: pendingTools.map((item) => item.activity),
      })
    }
    pendingTools = []
  }

  for (const item of timeline) {
    if (item.type === 'thinking' && !item.content.trim()) continue
    if (item.type === 'tool') {
      const previousTool = pendingTools.at(-1)
      if (previousTool && !isSameToolPhase(previousTool.activity, item.activity)) {
        flushTools()
      }
      pendingTools.push(item)
      continue
    }
    flushTools()
    grouped.push(item)
  }
  flushTools()

  return grouped
}

function isSameToolPhase(
  previous: NativeToolActivity,
  current: NativeToolActivity,
): boolean {
  const previousTurnId = previous.sourceLocator?.turnId
  const currentTurnId = current.sourceLocator?.turnId
  return !previousTurnId || !currentTurnId || previousTurnId === currentTurnId
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
  if (
    event.type === 'usage'
    || event.type === 'interaction_request'
    || event.type === 'evidence_progress'
  ) return current
  const incoming = timelineItemFromEvent(current, event)
  const index = current.findIndex((item) =>
    item.type === incoming.type && item.itemId === incoming.itemId,
  )
  if (index < 0) return [...current, incoming]
  return current.map((item, itemIndex) => itemIndex === index ? incoming : item)
}

function timelineItemFromEvent(
  current: NativeTurnTimelineItem[],
  event: Exclude<NativeChatEvent, {
    type: 'usage' | 'interaction_request' | 'evidence_progress'
  }>,
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
