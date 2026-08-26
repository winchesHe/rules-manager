import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupStaleSessionContextRuns,
  closeSessionContextRun,
  createSessionContextRun,
  getSessionContextStatus,
  listSessionContextOutcomes,
  listSessionContextProofs,
  listSessionContextSessions,
  locateSessionContextEvent,
  partitionSessionEvents,
  readSessionContextPart,
  reassembleSessionContextItems,
} from '../../src/session-context-run'
import type { SessionEvent, SessionEventReadResult } from '../../src/session-events'
import type { SessionQueryExecution } from '../../src/session-query'

function baseEvents(): SessionEvent[] {
  return [
    {
      index: 0,
      kind: 'message',
      role: 'user',
      content: 'first message',
      origin: 'human_user',
      originEvidence: 'source-envelope',
      sourceLocator: 'fixture:1',
    },
    {
      index: 1,
      kind: 'tool_call',
      role: 'assistant',
      toolName: 'mcp__chrome__navigate',
      toolCallId: 'call-1',
      content: { url: 'https://example.com' },
      origin: 'tool_runtime',
      originEvidence: 'source-envelope',
      sourceLocator: 'fixture:2',
    },
    {
      index: 2,
      kind: 'tool_result',
      role: 'tool',
      toolCallId: 'call-1',
      content: 'done',
      origin: 'tool_runtime',
      originEvidence: 'source-envelope',
      sourceLocator: 'fixture:3',
    },
  ]
}

function source(
  events = baseEvents(),
  fingerprint = 'a'.repeat(64),
): SessionEventReadResult {
  return {
    sessionId: 'session-1',
    agent: 'codex',
    projectSlug: 'demo',
    status: events.length > 0 ? 'readable' : 'empty',
    eventCount: events.length,
    events,
    sourceRevision: {
      kind: 'jsonl-watermark',
      fingerprint,
      changedDuringRun: false,
    },
  }
}

function execution(): SessionQueryExecution {
  const preparedSource = source()
  return {
    query: {
      version: 2,
      where: { usedTool: { families: ['chrome-use'] } },
      scope: { includeInternal: false },
    },
    queryHash: 'b'.repeat(64),
    evaluatedAt: '2026-08-10T00:00:00.000Z',
    coverage: {
      candidates: 2,
      inspected: 1,
      matched: 1,
      notMatched: 0,
      unknown: 1,
      unknownSource: 1,
      unknownOrigin: 0,
      unknownToolParse: 0,
      changedDuringRun: 0,
    },
    outcomes: [
      {
        sessionId: 'session-1',
        agent: 'codex',
        projectSlug: 'demo',
        updatedAt: '2026-08-09T00:00:00.000Z',
        status: 'updated',
        selectionStatus: 'matched',
        eventCount: 3,
        proofs: [{
          kind: 'tool_usage',
          eventIndex: 1,
          sourceLocator: 'fixture:2',
          family: 'chrome-use',
          toolName: 'mcp__chrome__navigate',
          provenance: 'direct',
        }],
        sourceRevision: preparedSource.sourceRevision,
      },
      {
        sessionId: 'missing',
        agent: 'claude',
        projectSlug: 'demo',
        updatedAt: '2026-08-08T00:00:00.000Z',
        status: 'updated',
        selectionStatus: 'unknown',
        eventCount: 0,
        proofs: [],
        errorCode: 'SOURCE_NOT_FOUND',
        errorMessage: 'missing',
      },
    ],
    matchedSources: [preparedSource],
  }
}

describe('Session Context Run', () => {
  let parentDir: string

  beforeEach(() => {
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-context-run-test-'))
  })

  afterEach(() => {
    fs.rmSync(parentDir, { recursive: true, force: true })
  })

  it('只创建轻量私有 manifest，不保存 Session 正文或 gzip 快照', () => {
    const summary = createSessionContextRun(execution(), {
      parentDir,
      now: new Date('2026-08-10T00:00:00.000Z'),
      ttlMs: 60_000,
    })
    const rootDir = path.join(parentDir, `memory-manager-context-${summary.runId}`)
    expect(fs.statSync(parentDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(rootDir).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(rootDir).sort()).toEqual(['manifest.json', 'owner.json'])
    expect(fs.statSync(path.join(rootDir, 'manifest.json')).mode & 0o777).toBe(0o600)
    const manifest = fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8')
    expect(manifest).not.toContain('first message')
    expect(manifest).not.toContain('https://example.com')
    expect(manifest).not.toContain('"content":"done"')
    expect(summary).toMatchObject({
      contentMode: 'live-source',
      contentStored: false,
      sessionCount: 1,
      coverage: { unknown: 1 },
    })
    expect(summary.limitations).toContain(
      '1 个候选 Session 无法检查，不能声明已找到全部相关 Session',
    )

    expect(listSessionContextSessions(summary.runId, {}, parentDir).items).toEqual([
      expect.objectContaining({
        id: 'session-1',
        eventCountAtPrepare: 3,
        proofCount: 1,
        proofKinds: { tool_usage: 1 },
        toolFamilies: ['chrome-use'],
        contentMode: 'live-source',
      }),
    ])
    expect(listSessionContextProofs(summary.runId, 'session-1', {}, parentDir).items).toEqual([
      expect.objectContaining({ kind: 'tool_usage', eventIndex: 1, family: 'chrome-use' }),
    ])
    expect(getSessionContextStatus(summary.runId, parentDir)).toMatchObject({
      runId: summary.runId,
      contentMode: 'live-source',
      contentStored: false,
      queryHash: 'b'.repeat(64),
    })

    expect(closeSessionContextRun(summary.runId, parentDir)).toEqual({
      runId: summary.runId,
      status: 'closed',
    })
    expect(fs.existsSync(rootDir)).toBe(false)
  })

  it('read 实时读取 prepare 后新增的事件，并重新计算当前分片和 Query 状态', async () => {
    const summary = createSessionContextRun(execution(), { parentDir })
    const latestEvents = [
      ...baseEvents(),
      {
        index: 3,
        kind: 'message' as const,
        role: 'assistant' as const,
        content: 'prepare 之后新增',
        origin: 'assistant_output' as const,
        originEvidence: 'source-envelope' as const,
        sourceLocator: 'fixture:4',
      },
    ]
    const part = await readSessionContextPart(summary.runId, 'session-1', 1, {
      parentDir,
      now: new Date('2026-08-10T01:00:00.000Z'),
      maxPartBytes: 10_000,
      readSources: async () => [source(latestEvents, 'c'.repeat(64))],
    })
    expect(part).toMatchObject({
      contentMode: 'live-source',
      readAt: '2026-08-10T01:00:00.000Z',
      selectionStatus: 'matched',
      selectionChanged: false,
      sourceChangedSincePrepare: true,
      eventCount: 4,
      part: 1,
      partCount: 1,
    })
    expect(reassembleSessionContextItems(part.events).at(-1)?.content).toBe('prepare 之后新增')
  })

  it('最新源不再符合 Query 时显式报告 selectionChanged', async () => {
    const summary = createSessionContextRun(execution(), { parentDir })
    const latestEvents = [baseEvents()[0]]
    const part = await readSessionContextPart(summary.runId, 'session-1', 1, {
      parentDir,
      maxPartBytes: 10_000,
      readSources: async () => [source(latestEvents, 'd'.repeat(64))],
    })
    expect(part).toMatchObject({
      selectionStatus: 'not_matched',
      selectionChanged: true,
      sourceChangedSincePrepare: true,
      currentProofCount: 0,
    })
  })

  it('全量查询命中的空 Session 返回一个可完成账本的空分片', async () => {
    const allSessionsExecution = execution()
    allSessionsExecution.query = {
      version: 2,
      scope: { includeInternal: false },
    }
    allSessionsExecution.outcomes[0].proofs = [{ kind: 'all' }]
    const summary = createSessionContextRun(allSessionsExecution, { parentDir })

    const part = await readSessionContextPart(summary.runId, 'session-1', 1, {
      parentDir,
      readSources: async () => [source([], 'e'.repeat(64))],
    })

    expect(part).toMatchObject({
      selectionStatus: 'matched',
      selectionChanged: false,
      eventCount: 0,
      itemCount: 0,
      part: 1,
      partCount: 1,
      events: [],
    })
  })

  it('locate 用稳定 sourceLocator 在最新事件序列中重新定位 proof', async () => {
    const summary = createSessionContextRun(execution(), { parentDir })
    const latestEvents = [
      {
        index: 0,
        kind: 'message' as const,
        role: 'user' as const,
        content: 'new prefix',
        origin: 'human_user' as const,
        originEvidence: 'source-envelope' as const,
        sourceLocator: 'fixture:0',
      },
      ...baseEvents().map((event) => ({ ...event, index: event.index + 1 })),
    ]
    await expect(locateSessionContextEvent(summary.runId, 'session-1', 1, {
      parentDir,
      maxPartBytes: 10_000,
      readSources: async () => [source(latestEvents, 'e'.repeat(64))],
    })).resolves.toMatchObject({
      requestedEventIndex: 1,
      eventIndex: 2,
      sourceLocator: 'fixture:2',
      sourceChangedSincePrepare: true,
      selectionStatus: 'matched',
      firstPart: 1,
      lastPart: 1,
    })
  })

  it('proof 锚点从最新源消失时明确失败', async () => {
    const summary = createSessionContextRun(execution(), { parentDir })
    await expect(locateSessionContextEvent(summary.runId, 'session-1', 1, {
      parentDir,
      readSources: async () => [source([baseEvents()[0]], 'f'.repeat(64))],
    })).rejects.toThrow('proof 锚点已不在最新源中')
  })

  it('单个超大事件拆成可校验片段并能逐字节还原，空事件不制造空分片', () => {
    const large = {
      index: 0,
      kind: 'message' as const,
      role: 'user' as const,
      content: `前缀-${'x\\"😀'.repeat(2_000)}-后缀`,
      origin: 'human_user' as const,
      originEvidence: 'source-envelope' as const,
      sourceLocator: 'fixture:1',
    }
    const parts = partitionSessionEvents([large], 512)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((part) => Buffer.byteLength(JSON.stringify(part), 'utf8') <= 514)).toBe(true)
    expect(reassembleSessionContextItems(parts.flat())).toEqual([large])
    expect(partitionSessionEvents([], 512)).toEqual([])
  })

  it('Session 与 outcome 都通过有界游标分页读取', () => {
    const summary = createSessionContextRun(execution(), { parentDir })
    expect(listSessionContextSessions(summary.runId, { limit: 1 }, parentDir)).toMatchObject({
      total: 1,
      returned: 1,
      cursor: '0',
    })
    expect(listSessionContextOutcomes(summary.runId, {
      cursor: '0',
      limit: 1,
    }, parentDir)).toMatchObject({
      total: 2,
      returned: 1,
      cursor: '0',
      nextCursor: '1',
    })
    expect(() => listSessionContextSessions(summary.runId, {
      cursor: '../1',
    }, parentDir)).toThrow('cursor 必须是非负整数')
    expect(() => listSessionContextSessions(summary.runId, {
      limit: 201,
    }, parentDir)).toThrow('limit 必须是 1-200 的整数')
  })

  it('拒绝无效 run/session/part，close 需要可验证所有权', async () => {
    expect(() => getSessionContextStatus('../unsafe', parentDir)).toThrow('无效 context run id')
    const summary = createSessionContextRun(execution(), { parentDir })
    await expect(readSessionContextPart(summary.runId, 'session-1', 0, {
      parentDir,
    })).rejects.toThrow('part 必须是从 1 开始的整数')
    await expect(readSessionContextPart(summary.runId, '../session-1', 1, {
      parentDir,
    })).rejects.toThrow('context run 中没有 Session')

    const rootDir = path.join(parentDir, `memory-manager-context-${summary.runId}`)
    fs.rmSync(path.join(rootDir, 'owner.json'))
    fs.rmSync(path.join(rootDir, 'manifest.json'))
    expect(() => closeSessionContextRun(summary.runId, parentDir)).toThrow('所有权校验失败')
  })

  it('TTL 清理 ready 与中断遗留 run，并保留活跃和无关目录', () => {
    const expired = createSessionContextRun(execution(), {
      parentDir,
      now: new Date('2026-08-10T00:00:00.000Z'),
      ttlMs: 1_000,
    })
    const active = createSessionContextRun(execution(), {
      parentDir,
      now: new Date('2026-08-10T00:00:00.000Z'),
      ttlMs: 120_000,
    })
    const interruptedRunId = '00000000-0000-4000-8000-000000000001'
    const interrupted = path.join(parentDir, `memory-manager-context-${interruptedRunId}`)
    fs.mkdirSync(interrupted)
    fs.writeFileSync(path.join(interrupted, 'owner.json'), JSON.stringify({
      runId: interruptedRunId,
      state: 'preparing',
      expiresAt: '2026-08-10T00:00:01.000Z',
    }))
    fs.mkdirSync(path.join(interrupted, 'sessions'))
    fs.writeFileSync(path.join(interrupted, 'sessions', 'legacy.parts.gz'), 'old snapshot')
    const unrelated = path.join(parentDir, 'unrelated')
    fs.mkdirSync(unrelated)

    expect(cleanupStaleSessionContextRuns({
      parentDir,
      now: new Date('2026-08-10T00:01:00.000Z'),
    }).sort()).toEqual([expired.runId, interruptedRunId].sort())
    expect(fs.existsSync(interrupted)).toBe(false)
    expect(getSessionContextStatus(active.runId, parentDir).runId).toBe(active.runId)
    expect(fs.existsSync(unrelated)).toBe(true)
  })
})
