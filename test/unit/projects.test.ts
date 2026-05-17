import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runInit } from '../../src/commands/init'
import { runScan } from '../../src/scanner'
import { listProjects } from '../../src/commands/projects'
import { getDbPath, initDatabase } from '../../src/db'

const SOURCES_DIR = path.resolve('test/sources')

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-p4-'))
}
function clean(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

// ─── schema v4 ────────────────────────────────────────────────────────────────

describe('schema v4', () => {
  let home: string
  beforeEach(async () => {
    home = makeTempHome()
    await runInit({ yes: true, homeDir: home })
  })
  afterEach(() => clean(home))

  it('schema_meta version = 4', () => {
    const db = initDatabase(home)
    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: string }
    db.close()
    expect(row.value).toBe('4')
  })

  it('session_projects 表存在并含 confidence 列', () => {
    const db = initDatabase(home)
    const cols = db.pragma('table_info(session_projects)') as Array<{ name: string }>
    db.close()
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['session_id', 'project_key', 'confidence', 'decided_at']),
    )
  })

  it('project_hints 表存在并含联合主键字段', () => {
    const db = initDatabase(home)
    const cols = db.pragma('table_info(project_hints)') as Array<{ name: string }>
    db.close()
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'session_id',
        'kind',
        'value',
        'project_key',
        'confidence',
        'agent',
        'source',
        'locator',
        'updated_at',
      ]),
    )
  })

  it('projects 表含 confidence 列', () => {
    const db = initDatabase(home)
    const cols = db.pragma('table_info(projects)') as Array<{ name: string }>
    db.close()
    expect(cols.some((c) => c.name === 'confidence')).toBe(true)
  })
})

// ─── e2e: 4 fixture → projects list ───────────────────────────────────────────

describe('plan 04 验收：scan test/sources --all → projects list', () => {
  let home: string
  beforeEach(async () => {
    home = makeTempHome()
    await runInit({ yes: true, homeDir: home })
  })
  afterEach(() => clean(home))

  it('4 个预期项目都被识别且 confidence ≥ 0.80', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })

    const items = listProjects({ homeDir: home })
    const byKey = new Map(items.map((i) => [i.projectKey, i]))

    for (const expected of [
      'Boarding_Desktop',
      'cloud-code-master',
      'agent-memory-system',
      'moego-chrome-extension',
    ]) {
      const item = byKey.get(expected)
      expect(item).toBeDefined()
      expect(item!.confidence).toBeGreaterThanOrEqual(0.8)
      expect(item!.sessionCount).toBeGreaterThanOrEqual(1)
    }
  })

  it('每个 session 在 session_projects 表里都有一行', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })

    const db = new Database(getDbPath(home), { readonly: true })
    const sessionCount = (
      db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }
    ).c
    const spCount = (
      db.prepare('SELECT COUNT(*) AS c FROM session_projects').get() as { c: number }
    ).c
    db.close()
    expect(spCount).toBe(sessionCount)
  })

  it('project_hints 表至少含 cwd / git_root / source_project_path 三种 kind', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })

    const db = new Database(getDbPath(home), { readonly: true })
    const kinds = db
      .prepare('SELECT DISTINCT kind FROM project_hints')
      .all() as Array<{ kind: string }>
    db.close()
    const set = new Set(kinds.map((k) => k.kind))
    expect(set.has('cwd')).toBe(true)
    expect(set.has('git_root')).toBe(true)
    expect(set.has('source_project_path')).toBe(true)
  })

  it('sessions.project_key 与 session_projects.project_key 同步', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })

    const db = new Database(getDbPath(home), { readonly: true })
    const mismatches = db
      .prepare(
        `SELECT s.id FROM sessions s
            LEFT JOIN session_projects sp ON sp.session_id = s.id
           WHERE s.project_key != sp.project_key
              OR (s.project_key IS NULL) != (sp.project_key IS NULL)`,
      )
      .all() as Array<{ id: string }>
    db.close()
    expect(mismatches).toEqual([])
  })

  it('重复扫描不重复堆积 project_hints（DELETE+INSERT 模式）', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
    const db1 = new Database(getDbPath(home), { readonly: true })
    const c1 = (
      db1.prepare('SELECT COUNT(*) AS c FROM project_hints').get() as { c: number }
    ).c
    db1.close()

    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
    const db2 = new Database(getDbPath(home), { readonly: true })
    const c2 = (
      db2.prepare('SELECT COUNT(*) AS c FROM project_hints').get() as { c: number }
    ).c
    db2.close()

    expect(c2).toBe(c1)
  })
})

// ─── listProjects 行为 ────────────────────────────────────────────────────────

describe('listProjects', () => {
  let home: string
  beforeEach(async () => {
    home = makeTempHome()
  })
  afterEach(() => clean(home))

  it('未初始化工作区 → 返回空数组（不抛）', () => {
    expect(listProjects({ homeDir: home })).toEqual([])
  })

  it('已初始化但未 scan → 返回空数组', async () => {
    await runInit({ yes: true, homeDir: home })
    expect(listProjects({ homeDir: home })).toEqual([])
  })

  it('scan 后按 session_count 降序排列', async () => {
    await runInit({ yes: true, homeDir: home })
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
    const items = listProjects({ homeDir: home })
    for (let i = 1; i < items.length; i++) {
      expect(items[i].sessionCount).toBeLessThanOrEqual(items[i - 1].sessionCount)
    }
  })
})
