import { describe, expect, it } from '@jest/globals'
import type { RuleCandidate } from '../renderer/src/types'
import {
  filterCandidatesByRun,
  selectableGenerationRuns,
} from '../renderer/src/views/rules-view-model'

function candidate(id: string, runId: string | null): RuleCandidate {
  return {
    id,
    run_id: runId,
    scope: 'global',
    project_slug: null,
    rule_text: id,
    confidence_level: 'high',
    status: 'draft',
    evidence_json: '{}',
    source_sessions: '[]',
    created_at: '2026-07-31T00:00:00.000Z',
    updated_at: '2026-07-31T00:00:00.000Z',
  }
}

describe('Rules generation batch view model', () => {
  it('默认返回全部候选，选择 runId 后只返回该批次', () => {
    const rows = [
      candidate('latest-1', 'latest'),
      candidate('older-1', 'older'),
      candidate('legacy', null),
    ]

    expect(filterCandidatesByRun(rows, null)).toEqual(rows)
    expect(filterCandidatesByRun(rows, 'latest')).toEqual([rows[0]])
    expect(filterCandidatesByRun(rows, 'missing')).toEqual([])
  })

  it('批次选择器只展示实际生成过候选的历史任务', () => {
    const history = [{
      id: 'latest',
      startedAt: '2026-07-31T10:00:00.000Z',
      status: 'completed' as const,
      request: { mode: 'changed7d' as const, projects: [] },
      candidateCount: 2,
      candidates: [candidate('latest-1', 'latest')],
    }, {
      id: 'failed',
      startedAt: '2026-07-31T09:00:00.000Z',
      status: 'failed' as const,
      request: { mode: 'changed7d' as const, projects: [] },
      candidateCount: 0,
      candidates: [],
    }]

    expect(selectableGenerationRuns(history)).toEqual([history[0]])
  })
})
