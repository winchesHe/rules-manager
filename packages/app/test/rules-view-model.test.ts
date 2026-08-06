import { describe, expect, it } from '@jest/globals'
import type { RuleCandidate } from '../renderer/src/types'
import {
  generationProviderEntries,
  filterCandidatesByRun,
  parseCandidateEvidence,
  parseEvidenceReference,
  selectableGenerationRuns,
} from '../renderer/src/views/rules-view-model'
import type { ProviderSnapshotEntry } from '../renderer/src/types'

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
  it('Rules 只保留支持结构化输出的 Provider，Pi 不得出现', () => {
    const entries = [
      providerEntry('claude', true),
      providerEntry('opencode', true),
      providerEntry('pi', false),
    ]
    expect(generationProviderEntries(entries).map((entry) => entry.id)).toEqual([
      'claude',
      'opencode',
    ])
  })
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

  it('解析结构化 Evidence locator，并兼容旧版 session:index 引用', () => {
    expect(parseEvidenceReference(JSON.stringify({
      sessionId: 'ses_123',
      agent: 'opencode',
      messageIndex: 115,
      timestamp: '1785210816521',
    }))).toEqual({
      raw: '{"sessionId":"ses_123","agent":"opencode","messageIndex":115,"timestamp":"1785210816521"}',
      sessionId: 'ses_123',
      agent: 'opencode',
      messageIndex: 115,
      timestamp: '1785210816521',
    })
    expect(parseEvidenceReference('legacy-session:7')).toEqual({
      raw: 'legacy-session:7',
      sessionId: 'legacy-session',
      messageIndex: 7,
    })
    expect(parseEvidenceReference('not-a-locator')).toBeNull()
  })

  it('从 candidate 独立的 source_sessions 字段读取来源会话', () => {
    const parsed = parseCandidateEvidence(
      JSON.stringify({
        reasoning: '用户明确提出硬性要求。',
        evidence_refs: ['session-a:2'],
      }),
      JSON.stringify(['session-a', 'session-b']),
    )

    expect(parsed.reasoning).toBe('用户明确提出硬性要求。')
    expect(parsed.references).toHaveLength(1)
    expect(parsed.sourceSessions).toEqual(['session-a', 'session-b'])
  })
})

function providerEntry(
  id: ProviderSnapshotEntry['id'],
  supportsStructuredOutput: boolean,
): ProviderSnapshotEntry {
  return {
    id,
    label: id,
    status: 'available',
    enabled: true,
    isDefault: id === 'claude',
    models: [],
    capabilities: {
      supportsStructuredOutput,
      supportsFastMode: id === 'claude' || id === 'codex',
      sessionLifecycle: id === 'pi' ? 'app-only' : 'native',
    },
  }
}
