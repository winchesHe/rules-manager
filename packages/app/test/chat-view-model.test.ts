import { describe, expect, it } from '@jest/globals'
import {
  formatElapsed,
  mergeTimelineActivities,
  shouldFollowStream,
  visibleProjectResponses,
} from '../renderer/src/views/chat-view-model.js'

describe('chat view model', () => {
  const responses = [{
    projectSlug: 'demo',
    summary: 'summary',
    candidates: [{
      rule: 'Always test',
      scope: 'project' as const,
      confidence: 'high' as const,
      reasoning: 'Repeated',
      evidenceRefs: ['session:0'],
    }],
  }]

  it.each([
    'running',
    'cancelling',
    'cancelled',
    'failed',
    'interrupted',
  ] as const)('%s 不暴露半成品 Rules', (status) => {
    expect(visibleProjectResponses(status, responses)).toEqual([])
  })

  it('completed 一次性返回全部 Rules', () => {
    expect(visibleProjectResponses('completed', responses)).toBe(responses)
  })

  it('格式化秒级 elapsed time', () => {
    expect(formatElapsed(
      '2026-07-30T00:00:00.000Z',
      Date.parse('2026-07-30T00:02:31.000Z'),
    )).toBe('2m 31s')
    expect(formatElapsed(
      '2026-07-30T00:00:00.000Z',
      Date.parse('2026-07-30T01:02:03.000Z'),
    )).toBe('1h 2m 3s')
  })

  it('只在接近底部时跟随新 Activity', () => {
    expect(shouldFollowStream({
      scrollTop: 530,
      clientHeight: 400,
      scrollHeight: 1_000,
    })).toBe(true)
    expect(shouldFollowStream({
      scrollTop: 100,
      clientHeight: 400,
      scrollHeight: 1_000,
    })).toBe(false)
  })

  it('同一 Activity 的 running / completed 更新合并为一行', () => {
    expect(mergeTimelineActivities([
      {
        seq: 1,
        at: '2026-07-30T00:00:00.000Z',
        id: 'thinking-1',
        kind: 'thinking',
        label: 'Thinking',
        status: 'running',
      },
      {
        seq: 2,
        at: '2026-07-30T00:00:02.000Z',
        id: 'thinking-1',
        kind: 'thinking',
        label: 'Thinking',
        status: 'completed',
        detail: '分析完成。',
      },
    ])).toEqual([{
      seq: 1,
      at: '2026-07-30T00:00:00.000Z',
      id: 'thinking-1',
      kind: 'thinking',
      label: 'Thinking',
      status: 'completed',
      detail: '分析完成。',
    }])
  })
})
