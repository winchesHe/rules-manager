import { describe, expect, it } from '@jest/globals'
import { mergeNativeTimelineEvent } from '../main/native-chat-timeline.js'
import {
  groupNativeTurnTimeline,
  mergeLiveTimeline,
  normalizeThinkingMarkdown,
  shouldShowNativeChatStop,
  toolActivityCounts,
} from '../renderer/src/views/chat-timeline-model.js'
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

describe('Native Chat Tool activity 分组', () => {
  it('只合并连续 Tool，并由 Assistant 与 Thinking 保留原始分组边界', () => {
    const timeline: NativeTurnTimelineItem[] = [
      { type: 'assistant', itemId: 'commentary-1', content: '先检查。' },
      {
        type: 'tool', itemId: 'read-1',
        activity: { itemId: 'read-1', kind: 'read', name: 'Read', status: 'completed' },
      },
      {
        type: 'tool', itemId: 'shell-1',
        activity: { itemId: 'shell-1', kind: 'shell', name: 'Command', status: 'running' },
      },
      { type: 'thinking', itemId: 'thinking-1', content: '继续确认。', status: 'completed' },
      {
        type: 'tool', itemId: 'search-1',
        activity: { itemId: 'search-1', kind: 'search', name: 'Search', status: 'failed' },
      },
      { type: 'assistant', itemId: 'final-1', content: '完成。' },
    ]

    const grouped = groupNativeTurnTimeline(timeline)

    expect(grouped.map((item) => `${item.type}:${item.itemId}`)).toEqual([
      'assistant:commentary-1',
      'tool-group:read-1',
      'thinking:thinking-1',
      'tool:search-1',
      'assistant:final-1',
    ])
    expect(grouped[1]).toMatchObject({
      type: 'tool-group',
      activities: [
        { itemId: 'read-1', status: 'completed' },
        { itemId: 'shell-1', status: 'running' },
      ],
    })
    expect(grouped[3]).toMatchObject({
      type: 'tool',
      activity: { itemId: 'search-1', status: 'failed' },
    })
  })

  it('只有一条 Tool activity 时直接返回单项，不创建汇总分组', () => {
    const tool: NativeTurnTimelineItem = {
      type: 'tool', itemId: 'shell-1',
      activity: {
        itemId: 'shell-1', kind: 'shell', name: 'Command',
        status: 'completed', summary: 'pwd',
      },
    }

    expect(groupNativeTurnTimeline([tool])).toEqual([tool])
  })

  it('空 Thinking 不切断可见 Tool 阶段，有正文 Thinking 仍保留边界', () => {
    const timeline: NativeTurnTimelineItem[] = [
      {
        type: 'tool', itemId: 'shell-1',
        activity: { itemId: 'shell-1', kind: 'shell', name: 'Command', status: 'completed' },
      },
      { type: 'thinking', itemId: 'thinking-empty', content: '  ', status: 'completed' },
      {
        type: 'tool', itemId: 'shell-2',
        activity: { itemId: 'shell-2', kind: 'shell', name: 'Command', status: 'completed' },
      },
      { type: 'thinking', itemId: 'thinking-visible', content: '继续核对。', status: 'completed' },
      {
        type: 'tool', itemId: 'shell-3',
        activity: { itemId: 'shell-3', kind: 'shell', name: 'Command', status: 'completed' },
      },
    ]

    expect(groupNativeTurnTimeline(timeline).map((item) => `${item.type}:${item.itemId}`)).toEqual([
      'tool-group:shell-1',
      'thinking:thinking-visible',
      'tool:shell-3',
    ])
  })

  it('按 Codex turnId 切分工具阶段，单工具阶段保持直接展示', () => {
    const timeline: NativeTurnTimelineItem[] = [
      {
        type: 'tool', itemId: 'turn-1-shell-1',
        activity: {
          itemId: 'turn-1-shell-1', kind: 'shell', name: 'Command', status: 'completed',
          sourceLocator: { turnId: 'turn-1', toolIndex: 0 },
        },
      },
      { type: 'thinking', itemId: 'thinking-empty', content: '', status: 'completed' },
      {
        type: 'tool', itemId: 'turn-1-shell-2',
        activity: {
          itemId: 'turn-1-shell-2', kind: 'shell', name: 'Command', status: 'completed',
          sourceLocator: { turnId: 'turn-1', toolIndex: 1 },
        },
      },
      {
        type: 'tool', itemId: 'turn-2-shell-1',
        activity: {
          itemId: 'turn-2-shell-1', kind: 'shell', name: 'Command', status: 'completed',
          sourceLocator: { turnId: 'turn-2', toolIndex: 0 },
        },
      },
    ]

    const grouped = groupNativeTurnTimeline(timeline)

    expect(grouped.map((item) => `${item.type}:${item.itemId}`)).toEqual([
      'tool-group:turn-1-shell-1',
      'tool:turn-2-shell-1',
    ])
  })

  it('空 timeline 不产生占位分组', () => {
    expect(groupNativeTurnTimeline([])).toEqual([])
  })

  it('按 Read、Search、Shell 与通用 Tool 汇总组头分类', () => {
    expect(toolActivityCounts([
      { itemId: 'read-1', kind: 'read', name: 'Read', status: 'completed' },
      { itemId: 'read-2', kind: 'read', name: 'Read', status: 'completed' },
      { itemId: 'search-1', kind: 'search', name: 'Search', status: 'completed' },
      { itemId: 'shell-1', kind: 'shell', name: 'Command', status: 'running' },
      { itemId: 'tool-1', kind: 'tool', name: 'Browser', status: 'failed' },
    ])).toEqual({ read: 2, search: 1, shell: 1, tool: 1 })
  })
})

describe('Native Chat Thinking Markdown', () => {
  it('为历史相邻加粗摘要补充分段，不改动正常 Markdown', () => {
    expect(normalizeThinkingMarkdown('**Planning****Evaluating**'))
      .toBe('**Planning**\n\n**Evaluating**')
    expect(normalizeThinkingMarkdown('**Planning**\n\n**Evaluating**'))
      .toBe('**Planning**\n\n**Evaluating**')
  })
})

describe('Native Chat 终止按钮运行态', () => {
  it('本地发送过程显示终止按钮', () => {
    expect(shouldShowNativeChatStop(true, null)).toBe(true)
  })

  it('从 Rules 跳转或刷新恢复的运行中 Native Chat 显示终止按钮', () => {
    expect(shouldShowNativeChatStop(false, {
      kind: 'native-chat',
      status: 'running',
    })).toBe(true)
  })

  it.each(['ready', 'failed', 'interrupted'])('Native Chat 终态 %s 不显示终止按钮', (status) => {
    expect(shouldShowNativeChatStop(false, {
      kind: 'native-chat',
      status,
    })).toBe(false)
  })

  it('非 Native Thread 不显示 Composer 终止按钮', () => {
    expect(shouldShowNativeChatStop(false, {
      kind: 'rules-generation',
      status: 'running',
    })).toBe(false)
  })
})
