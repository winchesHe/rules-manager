import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../../src/db'
import type { SessionEvent } from '../../src/session-events'
import {
  evaluateSessionPredicate,
  extractToolSignals,
  parseSessionQuery,
  runSessionQuery,
} from '../../src/session-query'
import type { AgentName, SessionStatus } from '../../src/types'
import { resolveWorkspace } from '../../src/workspace'

function event(
  index: number,
  input: Omit<SessionEvent, 'index' | 'sourceLocator'>,
): SessionEvent {
  return { index, sourceLocator: `fixture:${index + 1}`, ...input }
}

describe('Session Query', () => {
  describe('query schema', () => {
    it('补齐关键词默认值并拒绝未知字段、冲突时间和过深谓词', () => {
      expect(parseSessionQuery({
        version: 1,
        where: { keyword: { terms: ['Chrome'] } },
      })).toMatchObject({
        where: { keyword: { terms: ['Chrome'], mode: 'any', caseSensitive: false } },
      })

      expect(() => parseSessionQuery({ version: 2 })).toThrow()
      expect(() => parseSessionQuery({ version: 1, extra: true })).toThrow()
      expect(() => parseSessionQuery({
        version: 1,
        time: { lastDays: 7, since: '2026-08-01T00:00:00Z' },
      })).toThrow('lastDays 不能和 since/until 混用')

      let predicate: unknown = { keyword: { terms: ['x'] } }
      for (let depth = 0; depth < 9; depth++) predicate = { not: predicate }
      expect(() => parseSessionQuery({ version: 1, where: predicate })).toThrow(
        'where 递归深度不能超过 8',
      )
    })
  })

  describe('tool predicates', () => {
    const events: SessionEvent[] = [
      event(0, {
        kind: 'message',
        role: 'system',
        content: 'Available skills: computer-use and chrome-use',
      }),
      event(1, {
        kind: 'tool_call',
        role: 'assistant',
        toolName: 'exec',
        content: {
          code: 'const result = await tools.mcp__computer_use__computer({action:"click"})',
        },
      }),
      event(2, {
        kind: 'tool_call',
        role: 'assistant',
        toolName: 'mcp__chrome__navigate',
        content: { url: 'https://example.com' },
      }),
      event(3, {
        kind: 'tool_call',
        role: 'assistant',
        toolName: 'computer',
        content: { action: 'screenshot' },
      }),
    ]

    it('区分 direct、nested、capability-derived，且不读取 system 工具说明', () => {
      expect(extractToolSignals([events[0]])).toEqual([])
      expect(extractToolSignals(events)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          family: 'computer-use',
          toolName: 'mcp__computer_use__computer',
          provenance: 'nested',
          eventIndex: 1,
        }),
        expect.objectContaining({
          family: 'chrome-use',
          toolName: 'mcp__chrome__navigate',
          provenance: 'direct',
          eventIndex: 2,
        }),
        expect.objectContaining({
          family: 'computer-use',
          toolName: 'computer',
          provenance: 'capability-derived',
          operation: 'screenshot',
        }),
      ]))
    })

    it('按 family、operation 和 provenance 组合过滤并返回 locator', () => {
      const nested = evaluateSessionPredicate({
        tool: { families: ['computer-use'], provenance: ['nested'] },
      }, events)
      expect(nested).toMatchObject({ matched: true })
      expect(nested.proofs).toEqual([
        expect.objectContaining({
          kind: 'tool',
          family: 'computer-use',
          provenance: 'nested',
          eventIndex: 1,
          sourceLocator: 'fixture:2',
        }),
      ])

      expect(evaluateSessionPredicate({
        tool: { families: ['computer-use'], operations: ['screenshot'] },
      }, events).matched).toBe(true)
      expect(evaluateSessionPredicate({
        tool: { families: ['chrome-use'], provenance: ['nested'] },
      }, events).matched).toBe(false)
    })
  })

  describe('keyword and boolean predicates', () => {
    const events: SessionEvent[] = [
      event(0, { kind: 'message', role: 'system', content: 'permission denied in tool catalog' }),
      event(1, { kind: 'message', role: 'user', content: 'Chrome 联调又失败了' }),
      event(2, { kind: 'message', role: 'assistant', content: '需要重新授权 permission denied' }),
      event(3, { kind: 'tool_result', role: 'tool', content: { error: 'timeout' } }),
      event(4, { kind: 'metadata', content: { title: 'Browser Extension' } }),
    ]

    it('按字段匹配 any/all，system 内容默认不参与', () => {
      expect(evaluateSessionPredicate({
        keyword: { terms: ['permission denied'], mode: 'any', caseSensitive: false },
      }, [events[0]]).matched).toBe(false)

      const matched = evaluateSessionPredicate({
        keyword: {
          terms: ['chrome', 'permission denied'],
          mode: 'all',
          fields: ['user', 'assistant'],
          caseSensitive: false,
        },
      }, events)
      expect(matched.matched).toBe(true)
      expect(matched.proofs).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'keyword', term: 'chrome', field: 'user', eventIndex: 1 }),
        expect.objectContaining({
          kind: 'keyword',
          term: 'permission denied',
          field: 'assistant',
          eventIndex: 2,
        }),
      ]))
      expect(matched.proofs.every((proof) => proof.contentHash?.match(/^[a-f0-9]{64}$/))).toBe(
        true,
      )
    })

    it('递归组合 all/any/not，并为否定命中提供谓词 hash', () => {
      const result = evaluateSessionPredicate({
        all: [
          { keyword: { terms: ['extension'], mode: 'any', caseSensitive: false, fields: ['title'] } },
          { not: { keyword: { terms: ['success'], mode: 'any', caseSensitive: false } } },
          {
            any: [
              { keyword: { terms: ['timeout'], mode: 'any', caseSensitive: false } },
              { keyword: { terms: ['not-found'], mode: 'any', caseSensitive: false } },
            ],
          },
        ],
      }, events)

      expect(result.matched).toBe(true)
      expect(result.proofs).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'keyword', field: 'title' }),
        expect.objectContaining({ kind: 'keyword', field: 'tool_result_output' }),
        expect.objectContaining({ kind: 'not', predicateHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      ]))
    })
  })
})

describe('runSessionQuery integration', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-run-session-query-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function addSession(input: {
    id: string
    agent?: AgentName
    updatedAt: string
    content?: string
    status?: SessionStatus
  }): void {
    const sourcePath = path.join(home, `${input.id}.jsonl`)
    if (input.content !== undefined) {
      fs.writeFileSync(sourcePath, `${JSON.stringify({ role: 'user', content: input.content })}\n`)
    }
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'demo', 'hash', ?, ?, ?, ?)
    `).run(
      input.id,
      input.agent ?? 'codex',
      sourcePath,
      `/tmp/${input.id}.jsonl`,
      input.updatedAt,
      input.status ?? 'updated',
      input.updatedAt,
      input.updatedAt,
    )
    db.close()
  }

  it('时间候选全部进入 matched/notMatched/unknown，且 unknown 阻止完整选择结论', async () => {
    addSession({ id: 'matched', updatedAt: '2026-08-09T00:00:00.000Z', content: 'Chrome 调试失败' })
    addSession({ id: 'not-matched', updatedAt: '2026-08-08T00:00:00.000Z', content: '普通代码任务' })
    addSession({ id: 'unknown', updatedAt: '2026-08-07T00:00:00.000Z' })
    addSession({ id: 'old', updatedAt: '2026-07-01T00:00:00.000Z', content: 'Chrome old' })

    const result = await runSessionQuery({
      version: 1,
      time: { lastDays: 7 },
      where: { keyword: { terms: ['chrome'] } },
    }, {
      homeDir: home,
      now: new Date('2026-08-10T00:00:00.000Z'),
    })

    expect(result.coverage).toEqual({
      candidates: 3,
      inspected: 2,
      matched: 1,
      notMatched: 1,
      unknown: 1,
      changedDuringRun: 0,
    })
    expect(result.outcomes.map(({ sessionId, selectionStatus }) => ({
      sessionId,
      selectionStatus,
    }))).toEqual([
      { sessionId: 'matched', selectionStatus: 'matched' },
      { sessionId: 'not-matched', selectionStatus: 'not_matched' },
      { sessionId: 'unknown', selectionStatus: 'unknown' },
    ])
    expect(result.matchedSources.map((source) => source.sessionId)).toEqual(['matched'])
  })

  it('无 where 的最近 7 天查询把所有可检查 Session 纳入全量选集', async () => {
    addSession({ id: 'first', updatedAt: '2026-08-09T00:00:00.000Z', content: 'first' })
    addSession({ id: 'second', updatedAt: '2026-08-08T00:00:00.000Z', content: 'second' })

    const result = await runSessionQuery({ version: 1, time: { lastDays: 7 } }, {
      homeDir: home,
      now: new Date('2026-08-10T00:00:00.000Z'),
    })

    expect(result.coverage).toMatchObject({
      candidates: 2,
      inspected: 2,
      matched: 2,
      notMatched: 0,
      unknown: 0,
    })
    expect(result.outcomes.every((outcome) => (
      outcome.selectionStatus === 'matched' && outcome.proofs[0]?.kind === 'all'
    ))).toBe(true)
  })

  it('流式回调逐 Session 消费命中正文且不在 Query 结果中保留事件', async () => {
    addSession({ id: 'stream-first', updatedAt: '2026-08-09T00:00:00.000Z', content: 'first' })
    addSession({ id: 'stream-second', updatedAt: '2026-08-08T00:00:00.000Z', content: 'second' })
    const consumed: Array<{ id: string; events: number }> = []

    const result = await runSessionQuery({ version: 1, time: { lastDays: 7 } }, {
      homeDir: home,
      now: new Date('2026-08-10T00:00:00.000Z'),
      retainMatchedSources: false,
      onMatchedSource: (source, outcome) => {
        expect(outcome.selectionStatus).toBe('matched')
        consumed.push({ id: source.sessionId, events: source.eventCount })
      },
    })

    expect(consumed).toEqual([
      { id: 'stream-first', events: 1 },
      { id: 'stream-second', events: 1 },
    ])
    expect(result.coverage.matched).toBe(2)
    expect(result.matchedSources).toEqual([])
  })
})
