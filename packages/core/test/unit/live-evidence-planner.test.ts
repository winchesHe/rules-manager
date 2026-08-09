import { planSessionEvidence } from '../../src/live-evidence-planner'

const selected = [
  { agent: 'codex' as const, id: 'session-1' },
  { agent: 'claude' as const, id: 'session-2' },
]

describe('Live Evidence Query Planner', () => {
  it.each([
    '总结这些 Session 的经验',
    '归纳所有会话里的教训',
    '比较跨 session 的处理方式',
    'Summarize all sessions and identify lessons learned',
    '帮我分析一下这个问题',
  ])('集合级或不确定请求使用 complete：%s', (question) => {
    expect(planSessionEvidence({ runId: 'run-1', question, selected })).toMatchObject({
      mode: 'complete', selected, batchByteBudget: 512 * 1024, maxConcurrency: 4,
    })
  })

  it.each([
    '找一下之前提到的测试命令',
    '哪个 Session 讨论过 SQLite WAL？',
    '给我一个相关例子',
    'Find the specific command from history',
  ])('单点历史查询使用 targeted：%s', (question) => {
    expect(planSessionEvidence({ runId: 'run-2', question, selected })).toMatchObject({
      mode: 'targeted', selected,
    })
  })

  it('显式模式覆盖自动判定，且复制 selection', () => {
    const plan = planSessionEvidence({
      runId: 'run-3', question: '找一个例子', selected, mode: 'complete',
      batchByteBudget: 1_024, maxConcurrency: 2,
    })
    expect(plan).toMatchObject({
      mode: 'complete', batchByteBudget: 1_024, maxConcurrency: 2,
      reason: '用户显式指定 complete 模式',
    })
    expect(plan?.selected).not.toBe(selected)
  })

  it('没有 Session Context 时返回 null', () => {
    expect(planSessionEvidence({
      runId: 'run-empty', question: '总结一下', selected: [],
    })).toBeNull()
  })
})
