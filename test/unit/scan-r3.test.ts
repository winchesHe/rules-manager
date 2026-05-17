import { jest } from '@jest/globals'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runInit } from '../../src/commands/init'
import { runScan } from '../../src/scanner'
import { initDatabase, getDbPath } from '../../src/db'
import { codexAdapter } from '../../src/adapters/codex'

const SOURCES_DIR = path.resolve('test/sources')

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-r3-'))
}
function clean(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

interface SessionRow {
  id: string
  agent: string
  scan_state: string
  message_count: number
  tool_call_count: number
  first_timestamp: string | null
  last_timestamp: string | null
  parsed_metadata: string | null
}

interface RunMetaRow {
  id: string
  run_type: string
  status: string
  details: string | null
}

// ─── R3a: schema v3 ───────────────────────────────────────────────────────────

describe('schema v3', () => {
  let home: string
  beforeEach(async () => {
    home = makeTempHome()
    await runInit({ yes: true, homeDir: home })
  })
  afterEach(() => clean(home))

  it('sessions 表含 ParsedSession 列', () => {
    const db = initDatabase(home)
    const cols = db.pragma('table_info(sessions)') as Array<{ name: string }>
    db.close()
    const names = new Set(cols.map((c) => c.name))
    for (const expected of [
      'message_count',
      'tool_call_count',
      'first_timestamp',
      'last_timestamp',
      'parsed_metadata',
    ]) {
      expect(names.has(expected)).toBe(true)
    }
  })

  it('run_metadata 表含 details 列', () => {
    const db = initDatabase(home)
    const cols = db.pragma('table_info(run_metadata)') as Array<{ name: string }>
    db.close()
    expect(cols.some((c) => c.name === 'details')).toBe(true)
  })

  it('schema_meta version ≥ 3（schema 持续演进）', () => {
    const db = initDatabase(home)
    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: string }
    db.close()
    expect(Number(row.value)).toBeGreaterThanOrEqual(3)
  })
})

// ─── R3a: scanner 写入 ParsedSession 字段 ─────────────────────────────────────

describe('scanner 写入 ParsedSession 字段', () => {
  let home: string
  beforeEach(async () => {
    home = makeTempHome()
    await runInit({ yes: true, homeDir: home })
  })
  afterEach(() => clean(home))

  it('codex session 行有 message_count / tool_call_count > 0，parsed_metadata 含 cwd', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })

    const db = new Database(getDbPath(home), { readonly: true })
    const row = db
      .prepare(
        `SELECT id, agent, scan_state, message_count, tool_call_count,
                first_timestamp, last_timestamp, parsed_metadata
           FROM sessions WHERE agent = 'codex' LIMIT 1`,
      )
      .get() as SessionRow | undefined
    db.close()

    expect(row).toBeDefined()
    expect(row!.message_count).toBeGreaterThan(0)
    expect(row!.tool_call_count).toBeGreaterThan(0)
    expect(row!.first_timestamp).toBeTruthy()
    expect(row!.last_timestamp).toBeTruthy()
    expect(row!.parsed_metadata).toBeTruthy()
    const meta = JSON.parse(row!.parsed_metadata!) as Record<string, string>
    expect(meta.cwd).toBe('/Users/moego-winches/Desktop/Company/person/cloud-code-master')
    expect(meta.branch).toBe('ralph/agent-core-runtime')
  })

  it('cursor session 行 messageCount > 0；parsed_metadata 是空对象（jsonl 无内嵌 cwd）', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })

    const db = new Database(getDbPath(home), { readonly: true })
    const row = db
      .prepare(
        `SELECT message_count, parsed_metadata FROM sessions WHERE agent = 'cursor' LIMIT 1`,
      )
      .get() as { message_count: number; parsed_metadata: string | null }
    db.close()

    expect(row.message_count).toBeGreaterThan(0)
    expect(row.parsed_metadata).toBe('{}')
  })
})

// ─── R3a: run_metadata 诊断行 ─────────────────────────────────────────────────

describe('run_metadata', () => {
  let home: string
  beforeEach(async () => {
    home = makeTempHome()
    await runInit({ yes: true, homeDir: home })
  })
  afterEach(() => clean(home))

  it('每次 runScan 写一行 run_type=scan，结束 status=success（无错误时）', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
    const db = new Database(getDbPath(home), { readonly: true })
    const rows = db
      .prepare(`SELECT id, run_type, status, details FROM run_metadata`)
      .all() as RunMetaRow[]
    db.close()

    expect(rows.length).toBe(1)
    expect(rows[0].run_type).toBe('scan')
    expect(rows[0].status).toBe('success')
    const details = JSON.parse(rows[0].details!) as {
      summary: { total: number; errors: number }
      errors: unknown[]
    }
    expect(details.summary.total).toBeGreaterThanOrEqual(4)
    expect(details.summary.errors).toBe(0)
    expect(details.errors).toEqual([])
  })

  it('多次 runScan 累积多行', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
    const db = new Database(getDbPath(home), { readonly: true })
    const count = db.prepare('SELECT COUNT(*) AS c FROM run_metadata').get() as {
      c: number
    }
    db.close()
    expect(count.c).toBe(2)
  })
})

// ─── R3b: parse 抛错 → 'error' state + run_metadata.details ──────────────────

describe("R3b: parse 抛错 → scan_state='error' + 诊断", () => {
  let home: string
  let originalParse: typeof codexAdapter.parse

  beforeEach(async () => {
    home = makeTempHome()
    await runInit({ yes: true, homeDir: home })
    originalParse = codexAdapter.parse
  })

  afterEach(() => {
    codexAdapter.parse = originalParse
    clean(home)
  })

  it('codex.parse 抛错时：sessions 该行 scan_state=error，summary.errors >= 1，run_metadata.status=partial', async () => {
    codexAdapter.parse = async () => {
      throw new Error('boom-parse')
    }
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    const summary = await runScan({ source: SOURCES_DIR, all: true, homeDir: home })

    errSpy.mockRestore()

    expect(summary.errors).toBeGreaterThanOrEqual(1)

    const db = new Database(getDbPath(home), { readonly: true })
    const errorRows = db
      .prepare(`SELECT id, agent, scan_state FROM sessions WHERE scan_state = 'error'`)
      .all() as Array<{ id: string; agent: string; scan_state: string }>
    const meta = db
      .prepare(`SELECT status, details FROM run_metadata`)
      .get() as { status: string; details: string | null }
    db.close()

    expect(errorRows.length).toBeGreaterThanOrEqual(1)
    expect(errorRows[0].agent).toBe('codex')

    expect(meta.status).toBe('partial')
    const details = JSON.parse(meta.details!) as {
      errors: Array<{ stage: string; agent: string; message: string }>
    }
    expect(details.errors.length).toBeGreaterThanOrEqual(1)
    expect(details.errors[0].stage).toBe('parse')
    expect(details.errors[0].agent).toBe('codex')
    expect(details.errors[0].message).toContain('boom-parse')
  })
})

// ─── R3a: 默认 source 路径 ────────────────────────────────────────────────────

describe('runScan 默认 source 路径', () => {
  let home: string
  beforeEach(async () => {
    home = makeTempHome()
    await runInit({ yes: true, homeDir: home })
  })
  afterEach(() => clean(home))

  it('未传 --source → 默认走 ~/.memory-manager/sources（不存在时不报错，total=0）', async () => {
    const summary = await runScan({ all: true, homeDir: home })
    expect(summary.total).toBe(0)
    expect(summary.errors).toBe(0)
  })

  it('未传 --source 但工作区下有 sources/<agent>/ → 能扫到', async () => {
    const sourcesDir = path.join(home, '.memory-manager', 'sources')
    fs.mkdirSync(sourcesDir, { recursive: true })
    fs.cpSync(path.join(SOURCES_DIR, 'codex'), path.join(sourcesDir, 'codex'), {
      recursive: true,
    })

    const summary = await runScan({ all: true, homeDir: home })
    expect(summary.total).toBeGreaterThanOrEqual(1)
    expect(summary.errors).toBe(0)
  })
})
