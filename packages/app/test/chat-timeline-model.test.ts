import { describe, expect, it } from '@jest/globals'
import { mergeNativeTimelineEvent } from '../main/native-chat-timeline.js'
import { mergeLiveTimeline } from '../renderer/src/views/chat-timeline-model.js'
import type { NativeChatEvent, NativeTurnTimelineItem } from '../main/chat-runtime.js'

type TimelineMerge = (
  current: NativeTurnTimelineItem[],
  event: NativeChatEvent,
) => NativeTurnTimelineItem[]

const timelineMerges: Array<[string, TimelineMerge]> = [
  ['Main', mergeNativeTimelineEvent],
  ['Renderer', mergeLiveTimeline as TimelineMerge],
]

describe.each(timelineMerges)('%s Native Chat timeline', (_name, merge) => {
  it('按首次出现顺序保留 Assistant、Thinking 与 Tool，并原位更新 Tool', () => {
    const events: NativeChatEvent[] = [
      { type: 'assistant_delta', itemId: 'commentary-1', text: '先检查。' },
      {
        type: 'tool_activity',
        activity: { itemId: 'tool-1', kind: 'read', name: 'Read', status: 'running' },
      },
      { type: 'thinking_delta', itemId: 'thinking-1', text: '需要继续确认。' },
      {
        type: 'tool_activity',
        activity: { itemId: 'tool-2', kind: 'shell', name: 'Command', status: 'completed' },
      },
      { type: 'assistant_delta', itemId: 'final-1', text: '最终结论。' },
      {
        type: 'tool_activity',
        activity: { itemId: 'tool-1', kind: 'read', name: 'Read', status: 'completed' },
      },
    ]
    const timeline = events.reduce<NativeTurnTimelineItem[]>(
      (current, event) => merge(current, event),
      [],
    )

    expect(timeline.map((item) => `${item.type}:${item.itemId}`)).toEqual([
      'assistant:commentary-1',
      'tool:tool-1',
      'thinking:thinking-1',
      'tool:tool-2',
      'assistant:final-1',
    ])
    expect(timeline[1]).toMatchObject({
      type: 'tool', activity: { status: 'completed' },
    })
  })

  it('使用同一 item 的累计快照替换增量，避免 IPC 重复正文', () => {
    const first = merge([], {
      type: 'assistant_delta', itemId: 'message-1', text: '你', content: '你',
    })
    const second = merge(first, {
      type: 'assistant_delta', itemId: 'message-1', text: '好', content: '你好',
    })
    const duplicate = merge(second, {
      type: 'assistant_delta', itemId: 'message-1', text: '好', content: '你好',
    })

    expect(duplicate).toEqual([{ type: 'assistant', itemId: 'message-1', content: '你好' }])
  })
})
