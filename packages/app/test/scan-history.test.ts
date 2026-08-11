import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from '@jest/globals'
import {
  listChangedSessionIds,
  listCompletedScans,
  loadLatestCompletedScan,
} from '../main/scan-history.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createDatabase(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'memory-manager-scan-history-'))
  temporaryDirectories.push(directory)
  const dbPath = path.join(directory, 'memory.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE run_metadata (
      id TEXT PRIMARY KEY,
      run_type TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      details TEXT
    )
  `)
  db.close()
  return dbPath
}

describe('scan history', () => {
  it('恢复最近一次已完成 scan，并忽略更晚的 running 记录', () => {
    const dbPath = createDatabase()
    const db = new Database(dbPath)
    db.prepare(`
      INSERT INTO run_metadata
        (id, run_type, started_at, ended_at, status, details)
      VALUES (?, 'scan', ?, ?, ?, ?)
    `).run(
      'completed',
      '2026-07-28T09:00:00.000Z',
      '2026-07-28T09:01:00.000Z',
      'success',
      JSON.stringify({
        summary: {
          total: 12,
          new: 2,
          updated: 1,
          unchanged: 9,
          missing: 0,
          errors: 0,
          changes: {
            new: [{ agent: 'codex', id: 's1', slug: 'rules-manager' }],
            updated: [{ agent: 'claude', id: 's2', slug: 'rules-manager' }],
            missing: [],
          },
        },
      }),
    )
    db.prepare(`
      INSERT INTO run_metadata
        (id, run_type, started_at, ended_at, status, details)
      VALUES (?, 'scan', ?, NULL, 'running', NULL)
    `).run('running', '2026-07-29T09:00:00.000Z')
    db.close()

    expect(loadLatestCompletedScan(dbPath)).toEqual({
      completedAt: '2026-07-28T09:01:00.000Z',
      restored: true,
      summary: expect.objectContaining({
        total: 12,
        new: 2,
        updated: 1,
      }),
    })
  })

  it('兼容旧 scan summary 缺少 changes', () => {
    const dbPath = createDatabase()
    const db = new Database(dbPath)
    db.prepare(`
      INSERT INTO run_metadata
        (id, run_type, started_at, ended_at, status, details)
      VALUES (?, 'scan', ?, ?, 'partial', ?)
    `).run(
      'legacy',
      '2026-07-27T09:00:00.000Z',
      '2026-07-27T09:01:00.000Z',
      JSON.stringify({
        summary: {
          total: 3,
          new: 0,
          updated: 0,
          unchanged: 3,
          missing: 0,
          errors: 1,
        },
      }),
    )
    db.close()

    expect(loadLatestCompletedScan(dbPath)?.summary.changes).toEqual({
      new: [],
      updated: [],
      missing: [],
    })
  })

  it('列出最近 7 天已完成记录，并汇总去重的新增/更新 session', () => {
    const dbPath = createDatabase()
    const db = new Database(dbPath)
    const insert = db.prepare(`
      INSERT INTO run_metadata
        (id, run_type, started_at, ended_at, status, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const summary = (
      changes: {
        new?: Array<{ agent: string; id: string; slug: string }>
        updated?: Array<{ agent: string; id: string; slug: string }>
        missing?: Array<{ agent: string; id: string; slug: string }>
      },
    ) => JSON.stringify({
      summary: {
        total: 4,
        new: changes.new?.length ?? 0,
        updated: changes.updated?.length ?? 0,
        unchanged: 0,
        missing: changes.missing?.length ?? 0,
        errors: 0,
        changes: {
          new: changes.new ?? [],
          updated: changes.updated ?? [],
          missing: changes.missing ?? [],
        },
      },
    })
    insert.run(
      'recent-newest',
      'scan',
      '2026-07-29T09:00:00.000Z',
      '2026-07-29T09:02:00.000Z',
      'success',
      summary({
        new: [{ agent: 'codex', id: 's1', slug: 'demo' }],
        updated: [{ agent: 'claude', id: 's2', slug: 'demo' }],
      }),
    )
    insert.run(
      'recent-older',
      'scan',
      '2026-07-25T09:00:00.000Z',
      '2026-07-25T09:03:00.000Z',
      'partial',
      summary({
        updated: [{ agent: 'codex', id: 's1', slug: 'demo' }],
        new: [{ agent: 'pi', id: 's3', slug: 'tools' }],
        missing: [{ agent: 'cursor', id: 'missing', slug: 'old' }],
      }),
    )
    insert.run(
      'too-old',
      'scan',
      '2026-07-20T09:00:00.000Z',
      '2026-07-20T09:01:00.000Z',
      'success',
      summary({ new: [{ agent: 'codex', id: 'old', slug: 'old' }] }),
    )
    insert.run(
      'running',
      'scan',
      '2026-07-29T10:00:00.000Z',
      null,
      'running',
      null,
    )
    insert.run(
      'other-run',
      'rules-generate',
      '2026-07-29T08:00:00.000Z',
      '2026-07-29T08:01:00.000Z',
      'success',
      summary({ new: [{ agent: 'codex', id: 'other', slug: 'demo' }] }),
    )
    db.close()

    const options = { days: 7, now: new Date('2026-07-29T12:00:00.000Z') }
    expect(listCompletedScans(dbPath, options).map((run) => run.id)).toEqual([
      'recent-newest',
      'recent-older',
    ])
    expect(listChangedSessionIds(dbPath, options)).toEqual(['s1', 's2', 's3'])
  })

  it('History 默认列出全部记录，并恢复每次扫描的时间范围', () => {
    const dbPath = createDatabase()
    const db = new Database(dbPath)
    const insert = db.prepare(`
      INSERT INTO run_metadata
        (id, run_type, started_at, ended_at, status, details)
      VALUES (?, 'scan', ?, ?, 'success', ?)
    `)
    const summary = {
      total: 1,
      new: 1,
      updated: 0,
      unchanged: 0,
      missing: 0,
      errors: 0,
      changes: { new: [], updated: [], missing: [] },
    }
    insert.run(
      'recent-window',
      '2026-07-29T09:00:00.000Z',
      '2026-07-29T09:01:00.000Z',
      JSON.stringify({ summary, scope: { mode: 'recent', days: 14 } }),
    )
    insert.run(
      'legacy-full',
      '2026-01-01T09:00:00.000Z',
      '2026-01-01T09:01:00.000Z',
      JSON.stringify({ summary }),
    )
    db.close()

    expect(listCompletedScans(dbPath)).toEqual([
      expect.objectContaining({
        id: 'recent-window',
        scope: { mode: 'recent', days: 14 },
      }),
      expect.objectContaining({
        id: 'legacy-full',
        scope: { mode: 'full' },
      }),
    ])
  })

  it('History 包含已取消扫描，但 Latest 仍指向最近一次成功完成的扫描', () => {
    const dbPath = createDatabase()
    const db = new Database(dbPath)
    const summary = {
      total: 2,
      new: 1,
      updated: 0,
      unchanged: 1,
      missing: 0,
      errors: 0,
      changes: { new: [], updated: [], missing: [] },
    }
    const insert = db.prepare(`
      INSERT INTO run_metadata
        (id, run_type, started_at, ended_at, status, details)
      VALUES (?, 'scan', ?, ?, ?, ?)
    `)
    insert.run(
      'completed',
      '2026-07-29T08:00:00.000Z',
      '2026-07-29T08:01:00.000Z',
      'success',
      JSON.stringify({ summary }),
    )
    insert.run(
      'cancelled',
      '2026-07-29T09:00:00.000Z',
      '2026-07-29T09:00:30.000Z',
      'cancelled',
      JSON.stringify({
        summary: {
          ...summary,
          total: 1,
          new: 0,
          unchanged: 1,
        },
        scope: { mode: 'recent', days: 7 },
      }),
    )
    db.close()

    expect(listCompletedScans(dbPath).map((run) => run.id)).toEqual([
      'cancelled',
      'completed',
    ])
    expect(loadLatestCompletedScan(dbPath)?.completedAt).toBe(
      '2026-07-29T08:01:00.000Z',
    )
  })
})
