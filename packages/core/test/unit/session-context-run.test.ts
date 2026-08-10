import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupStaleSessionContextRuns,
  closeSessionContextRun,
  createSessionContextRun,
  createSessionContextRunWriter,
  getSessionContextStatus,
  listSessionContextOutcomes,
  listSessionContextProofs,
  listSessionContextSessions,
  locateSessionContextEvent,
  partitionSessionEvents,
  readSessionContextPart,
  reassembleSessionContextItems,
} from '../../src/session-context-run'
import type { SessionEventReadResult } from '../../src/session-events'
import type { SessionQueryExecution } from '../../src/session-query'

function execution(): SessionQueryExecution {
  const source: SessionEventReadResult = {
    sessionId: 'session-1',
    agent: 'codex',
    projectSlug: 'demo',
    status: 'readable',
    eventCount: 3,
    events: [
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
    ],
    sourceRevision: {
      kind: 'jsonl-watermark',
      fingerprint: 'a'.repeat(64),
      changedDuringRun: false,
    },
  }
  return {
    query: { version: 1, time: { lastDays: 30 } },
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
          kind: 'tool',
          eventIndex: 1,
          sourceLocator: 'fixture:2',
          family: 'chrome-use',
          toolName: 'mcp__chrome__navigate',
          provenance: 'direct',
        }],
        sourceRevision: source.sourceRevision,
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
    matchedSources: [source],
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

  it('创建 0700/0600 私有 run，按事件边界分页并可显式 close', () => {
    const summary = createSessionContextRun(execution(), {
      parentDir,
      now: new Date('2026-08-10T00:00:00.000Z'),
      ttlMs: 60_000,
      maxPartBytes: 512,
    })
    const rootDir = path.join(parentDir, `memory-manager-context-${summary.runId}`)
    expect(fs.statSync(parentDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(rootDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(rootDir, 'manifest.json')).mode & 0o777).toBe(0o600)
    const storageFiles = fs.readdirSync(path.join(rootDir, 'sessions'))
    expect(storageFiles).toEqual(['session-0001.parts.gz'])
    expect(fs.statSync(path.join(rootDir, 'sessions', storageFiles[0])).mode & 0o777).toBe(0o600)
    expect(summary.coverage.unknown).toBe(1)
    expect(listSessionContextOutcomes(summary.runId, {
      status: 'unknown',
    }, parentDir).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: 'missing',
        selectionStatus: 'unknown',
        errorCode: 'SOURCE_NOT_FOUND',
      }),
    ]))
    expect(summary.limitations).toContain(
      '1 个候选 Session 无法检查，不能声明已找到全部相关 Session',
    )
    const sessions = listSessionContextSessions(summary.runId, {}, parentDir).items
    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'session-1',
        eventCount: 3,
        proofCount: 1,
        proofKinds: { tool: 1 },
        toolFamilies: ['chrome-use'],
      }),
    ])
    expect(sessions[0]).not.toHaveProperty('proofs')
    expect(sessions[0]).not.toHaveProperty('eventParts')
    expect(sessions[0].partCount).toBeGreaterThan(0)

    const events = Array.from({ length: sessions[0].partCount }, (_, index) => (
      readSessionContextPart(summary.runId, 'session-1', index + 1, parentDir)
    )).flatMap((part) => part.events)
    const reassembled = reassembleSessionContextItems(events)
    expect(reassembled.map((event) => event.index)).toEqual([0, 1, 2])
    expect(reassembled.filter((event) => event.index === 1)).toHaveLength(1)
    expect(listSessionContextProofs(summary.runId, 'session-1', {}, parentDir).items).toEqual([
      expect.objectContaining({ kind: 'tool', eventIndex: 1, family: 'chrome-use' }),
    ])
    expect(locateSessionContextEvent(summary.runId, 'session-1', 1, parentDir)).toMatchObject({
      sessionId: 'session-1',
      eventIndex: 1,
      firstPart: expect.any(Number),
      lastPart: expect.any(Number),
    })
    expect(getSessionContextStatus(summary.runId, parentDir)).toMatchObject({
      runId: summary.runId,
      queryHash: 'b'.repeat(64),
      coverage: { matched: 1, unknown: 1 },
    })

    expect(closeSessionContextRun(summary.runId, parentDir)).toEqual({
      runId: summary.runId,
      status: 'closed',
    })
    expect(fs.existsSync(rootDir)).toBe(false)
    expect(closeSessionContextRun(summary.runId, parentDir)).toEqual({
      runId: summary.runId,
      status: 'not_found',
    })
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
    const summary = createSessionContextRun(execution(), { parentDir, maxPartBytes: 10_000 })
    expect(summary).toMatchObject({ sessionCount: 1 })
    expect(summary).not.toHaveProperty('sessions')
    expect(summary).not.toHaveProperty('outcomes')

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
    expect(listSessionContextOutcomes(summary.runId, {
      status: 'unknown',
      limit: 10,
    }, parentDir).items).toEqual([
      expect.objectContaining({ sessionId: 'missing', selectionStatus: 'unknown' }),
    ])
    expect(() => listSessionContextSessions(summary.runId, {
      cursor: '../1',
    }, parentDir)).toThrow('cursor 必须是非负整数')
    expect(() => listSessionContextSessions(summary.runId, {
      limit: 201,
    }, parentDir)).toThrow('limit 必须是 1-200 的整数')
  })

  it('拒绝 run/session/part 路径穿越和 manifest 越界目录', () => {
    expect(() => getSessionContextStatus('../unsafe', parentDir)).toThrow('无效 context run id')
    const summary = createSessionContextRun(execution(), { parentDir, maxPartBytes: 10_000 })
    expect(() => readSessionContextPart(summary.runId, 'session-1', 0, parentDir)).toThrow(
      'part 必须是从 1 开始的整数',
    )
    expect(() => readSessionContextPart(summary.runId, '../session-1', 1, parentDir)).toThrow(
      'context run 中没有 Session',
    )

    const manifestPath = path.join(
      parentDir,
      `memory-manager-context-${summary.runId}`,
      'manifest.json',
    )
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      sessions: Array<{ storageFile: string }>
    }
    manifest.sessions[0].storageFile = '../outside'
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => readSessionContextPart(summary.runId, 'session-1', 1, parentDir)).toThrow(
      'context manifest 包含越界路径',
    )
  })

  it('TTL 只清理 manifest 可验证且过期的 context run', () => {
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
    const unrelated = path.join(parentDir, 'unrelated')
    fs.mkdirSync(unrelated)

    expect(cleanupStaleSessionContextRuns({
      parentDir,
      now: new Date('2026-08-10T00:01:00.000Z'),
    })).toEqual([expired.runId])
    expect(() => getSessionContextStatus(expired.runId, parentDir)).toThrow('context run 不存在')
    expect(getSessionContextStatus(active.runId, parentDir).runId).toBe(active.runId)
    expect(fs.existsSync(unrelated)).toBe(true)
  })

  it('进程中断遗留的 preparing run 也可通过 owner marker 按 TTL 安全清理', () => {
    const writer = createSessionContextRunWriter({
      parentDir,
      now: new Date('2026-08-10T00:00:00.000Z'),
      ttlMs: 1_000,
    })
    const rootDir = path.join(parentDir, `memory-manager-context-${writer.runId}`)
    expect(fs.statSync(path.join(rootDir, 'owner.json')).mode & 0o777).toBe(0o600)

    expect(cleanupStaleSessionContextRuns({
      parentDir,
      now: new Date('2026-08-10T00:01:00.000Z'),
    })).toEqual([writer.runId])
    expect(fs.existsSync(rootDir)).toBe(false)
  })
})
