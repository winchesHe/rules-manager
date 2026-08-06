import { describe, expect, it } from '@jest/globals'
import {
  assistantTurnStartedAt,
  canRegenerate,
  createProviderSnapshotSync,
  formatElapsed,
  mergeTimelineActivities,
  shouldFollowStream,
  shouldSubmitComposer,
  toggleAvailableSessionSelection,
  virtualWindowRange,
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
    [{ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 }, true],
    [{ key: 'Enter', shiftKey: true, isComposing: false, keyCode: 13 }, false],
    [{ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13 }, false],
    [{ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 }, false],
    [{ key: 'a', shiftKey: false, isComposing: false, keyCode: 65 }, false],
  ])('Composer 键盘事件 %o 的发送判定为 %s', (event, expected) => {
    expect(shouldSubmitComposer(event)).toBe(expected)
  })

  it.each([
    'running',
    'cancelling',
    'cancelled',
    'interrupted',
  ] as const)('%s 不暴露半成品 Rules', (status) => {
    expect(visibleProjectResponses(status, responses)).toEqual([])
  })

  it('completed 一次性返回全部 Rules', () => {
    expect(visibleProjectResponses('completed', responses)).toBe(responses)
  })

  it('Provider 全量更新不会被首次返回的空 snapshot 覆盖', () => {
    const applied: Array<{ entries: Array<{ id: string }> }> = []
    const sync = createProviderSnapshotSync((snapshot) => applied.push(snapshot))
    const fullSnapshot = {
      entries: [{
        id: 'codex' as const,
        label: 'Codex',
        status: 'available' as const,
        enabled: true,
        isDefault: true,
        models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', source: 'discovered' as const }],
        fetchedAt: '2026-08-06T00:00:00.000Z',
      }],
      refreshing: false,
    }

    sync.receiveUpdate(fullSnapshot)
    sync.receiveInitial({ entries: [], refreshing: true })

    expect(applied).toEqual([fullSnapshot])
  })

  it('Provider 初始 snapshot 后仍接收后台全量更新，卸载后停止写入', () => {
    const applied: Array<{ entries: Array<{ id: string }> }> = []
    const sync = createProviderSnapshotSync((snapshot) => applied.push(snapshot))
    const initialSnapshot = { entries: [], refreshing: true }
    const fullSnapshot = {
      entries: [{
        id: 'claude' as const,
        label: 'Claude',
        status: 'available' as const,
        enabled: true,
        isDefault: true,
        models: [{ id: 'sonnet', label: 'Sonnet', source: 'discovered' as const }],
        fetchedAt: '2026-08-06T00:00:00.000Z',
      }],
      refreshing: false,
    }

    sync.receiveInitial(initialSnapshot)
    sync.receiveUpdate(fullSnapshot)
    sync.stop()
    sync.receiveUpdate({ ...fullSnapshot, entries: [] })

    expect(applied).toEqual([initialSnapshot, fullSnapshot])
  })

  it('failed 终态仍展示已完成项目并过滤失败项目', () => {
    const failedProject = {
      projectSlug: 'broken',
      summary: 'failed',
      candidates: [],
      status: 'failed' as const,
      error: 'invalid output',
    }

    expect(visibleProjectResponses('failed', [
      { ...responses[0], status: 'completed' },
      failedProject,
    ])).toEqual([
      { ...responses[0], status: 'completed' },
    ])
    expect(visibleProjectResponses('failed', responses)).toEqual(responses)
  })

  it('只有失败、取消或中断的 Thread 可以重新生成', () => {
    expect(canRegenerate('failed')).toBe(true)
    expect(canRegenerate('cancelled')).toBe(true)
    expect(canRegenerate('interrupted')).toBe(true)
    expect(canRegenerate('running')).toBe(false)
    expect(canRegenerate('cancelling')).toBe(false)
    expect(canRegenerate('completed')).toBe(false)
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

  it('旧 Assistant 时间戳无耗时时回退到前一条用户消息', () => {
    const messages = [
      { id: 'u1', role: 'user' as const, kind: 'text' as const, content: '开始', status: 'completed' as const, createdAt: '2026-08-02T12:00:00.000Z' },
      { id: 'a1', role: 'assistant' as const, kind: 'text' as const, content: '完成', status: 'completed' as const, createdAt: '2026-08-02T12:00:05.000Z', completedAt: '2026-08-02T12:00:05.000Z' },
    ]
    expect(assistantTurnStartedAt(messages, 1)).toBe('2026-08-02T12:00:00.000Z')
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

  it('Session viewport 变高时扩大虚拟渲染范围', () => {
    expect(virtualWindowRange({
      itemCount: 100,
      overscan: 4,
      rowHeight: 58,
      scrollTop: 0,
      viewportHeight: 290,
    })).toEqual({ start: 0, end: 9 })
    expect(virtualWindowRange({
      itemCount: 100,
      overscan: 4,
      rowHeight: 58,
      scrollTop: 0,
      viewportHeight: 580,
    })).toEqual({ start: 0, end: 14 })
  })

  it('全选只切换当前筛选结果并保留筛选外选择', () => {
    const outside = { agent: 'claude', id: 'outside' }
    const available = [
      { agent: 'codex', id: 'one' },
      { agent: 'opencode', id: 'two' },
    ]
    const selected = toggleAvailableSessionSelection(
      [outside, available[0]],
      available,
    )

    expect(selected).toEqual([outside, available[0], available[1]])
    expect(toggleAvailableSessionSelection(selected, available)).toEqual([outside])
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
