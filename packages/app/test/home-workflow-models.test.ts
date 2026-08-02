import { describe, expect, it } from '@jest/globals'
import {
  calculateVirtualWindow,
  filterProjectSessions,
  filterProjectRows,
  groupScanChanges,
} from '../renderer/src/view-models.js'

describe('home workflow view models', () => {
  it('按 project 汇总最近扫描的新增、更新和缺失 session', () => {
    expect(
      groupScanChanges({
        total: 4,
        new: 2,
        updated: 1,
        unchanged: 0,
        missing: 1,
        errors: 0,
        changes: {
          new: [
            { agent: 'codex', id: 's1', slug: 'rules-manager' },
            { agent: 'claude', id: 's2', slug: 'rules-manager' },
          ],
          updated: [{ agent: 'codex', id: 's3', slug: 'rules-manager' }],
          missing: [{ agent: 'pi', id: 's4', slug: 'agent-skills' }],
        },
      }),
    ).toEqual([
      {
        slug: 'rules-manager',
        agents: ['claude', 'codex'],
        newCount: 2,
        updatedCount: 1,
        missingCount: 0,
      },
      {
        slug: 'agent-skills',
        agents: ['pi'],
        newCount: 0,
        updatedCount: 0,
        missingCount: 1,
      },
    ])
  })

  it('Projects 搜索和筛选使用同一份行模型', () => {
    const rows = [
      { slug: 'rules-manager', changedCount: 3, draftCount: 2, isUnclassified: false },
      { slug: 'agent-skills', changedCount: 0, draftCount: 1, isUnclassified: false },
      { slug: 'default', changedCount: 1, draftCount: 0, isUnclassified: true },
    ]

    expect(filterProjectRows(rows, 'rules', 'all').map((row) => row.slug)).toEqual([
      'rules-manager',
    ])
    expect(filterProjectRows(rows, '', 'changed').map((row) => row.slug)).toEqual([
      'rules-manager',
      'default',
    ])
    expect(filterProjectRows(rows, '', 'draft').map((row) => row.slug)).toEqual([
      'rules-manager',
      'agent-skills',
    ])
    expect(filterProjectRows(rows, '', 'unclassified').map((row) => row.slug)).toEqual([
      'default',
    ])
  })

  it('长 Sessions 列表只计算可视窗口和 overscan 行', () => {
    expect(
      calculateVirtualWindow({
        itemCount: 12_480,
        scrollTop: 1_000,
        rowHeight: 56,
        viewportHeight: 336,
        overscan: 3,
      }),
    ).toEqual({
      start: 14,
      end: 27,
      offsetTop: 784,
      totalHeight: 698_880,
    })
  })

  it('Sessions 支持搜索、Agent 和状态组合筛选', () => {
    const sessions = [
      {
        id: 'codex-123',
        displayName: '修复规则生成',
        sourcePath: '/sessions/rules-manager.jsonl',
        agent: 'codex',
        status: 'updated',
      },
      {
        id: 'claude-456',
        displayName: '整理工作区',
        sourcePath: '/sessions/agent-workspace.jsonl',
        agent: 'claude',
        status: 'unchanged',
      },
      {
        id: 'codex-789',
        displayName: '检查发布流程',
        sourcePath: '/sessions/agent-workspace-2.jsonl',
        agent: 'codex',
        status: 'unchanged',
      },
    ]

    expect(
      filterProjectSessions(sessions, 'workspace', 'codex', 'unchanged').map(
        (session) => session.id,
      ),
    ).toEqual(['codex-789'])
    expect(
      filterProjectSessions(sessions, 'RULES', 'all', 'all').map(
        (session) => session.id,
      ),
    ).toEqual(['codex-123'])
    expect(
      filterProjectSessions(sessions, '发布', 'all', 'all').map(
        (session) => session.id,
      ),
    ).toEqual(['codex-789'])
  })
})
