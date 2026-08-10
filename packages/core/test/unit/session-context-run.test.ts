import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupStaleSessionContextRuns,
  closeSessionContextRun,
  createSessionContextRun,
  createSessionContextRunWriter,
  getSessionContextStatus,
  partitionSessionEvents,
  readSessionContextPart,
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
        sourceLocator: 'fixture:1',
      },
      {
        index: 1,
        kind: 'tool_call',
        role: 'assistant',
        toolName: 'mcp__chrome__navigate',
        toolCallId: 'call-1',
        content: { url: 'https://example.com' },
        sourceLocator: 'fixture:2',
      },
      {
        index: 2,
        kind: 'tool_result',
        role: 'tool',
        toolCallId: 'call-1',
        content: 'done',
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
      maxPartBytes: 180,
    })
    const rootDir = path.join(parentDir, `memory-manager-context-${summary.runId}`)
    expect(fs.statSync(parentDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(rootDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(rootDir, 'manifest.json')).mode & 0o777).toBe(0o600)
    expect(summary.coverage.unknown).toBe(1)
    expect(summary.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: 'missing',
        selectionStatus: 'unknown',
        errorCode: 'SOURCE_NOT_FOUND',
      }),
    ]))
    expect(summary.limitations).toContain(
      '1 个候选 Session 无法检查，不能声明已找到全部相关 Session',
    )
    expect(summary.sessions).toEqual([
      expect.objectContaining({ id: 'session-1', eventCount: 3, partCount: 3 }),
    ])

    const events = Array.from({ length: summary.sessions[0].partCount }, (_, index) => (
      readSessionContextPart(summary.runId, 'session-1', index + 1, parentDir)
    )).flatMap((part) => part.events)
    expect(events.map((event) => event.index)).toEqual([0, 1, 2])
    expect(events.filter((event) => event.index === 1)).toHaveLength(1)
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

  it('单个超大事件独立成片但不截断，空事件不制造空分片', () => {
    const large = {
      index: 0,
      kind: 'message' as const,
      role: 'user' as const,
      content: 'x'.repeat(2_000),
      sourceLocator: 'fixture:1',
    }
    expect(partitionSessionEvents([large], 100)).toEqual([[large]])
    expect(partitionSessionEvents([], 100)).toEqual([])
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
      sessions: Array<{ directory: string }>
    }
    manifest.sessions[0].directory = '../outside'
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
