import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runInit } from '../../src/commands/init'
import { runScan } from '../../src/scanner'
import {
  assignSession,
  listProjects,
  mergeProjects,
  reclassifyAll,
} from '../../src/projects'
import { getDbPath } from '../../src/db'

const SOURCES_DIR = path.resolve('test/sources')

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-p4r2-'))
}
function clean(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

async function setupScanned(home: string): Promise<void> {
  await runInit({ yes: true, homeDir: home })
  await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
}

function getSession(home: string, agent: string): { id: string; project_key: string | null } {
  const db = new Database(getDbPath(home), { readonly: true })
  const row = db
    .prepare('SELECT id, project_key FROM sessions WHERE agent = ? LIMIT 1')
    .get(agent) as { id: string; project_key: string | null }
  db.close()
  return row
}

// ─── assignSession ────────────────────────────────────────────────────────────

describe('assignSession', () => {
  let home: string
  beforeEach(async () => {
    home = makeTempHome()
    await setupScanned(home)
  })
  afterEach(() => clean(home))

  it('把 cursor session 从 moego-chrome-extension 改到自定义 project_key', () => {
    const cur = getSession(home, 'cursor')
    expect(cur.project_key).toBe('moego-chrome-extension')

    const r = assignSession(cur.id, 'my-custom-project', { homeDir: home })
    expect(r.previousKey).toBe('moego-chrome-extension')

    const cur2 = getSession(home, 'cursor')
    expect(cur2.project_key).toBe('my-custom-project')

    const items = listProjects({ homeDir: home })
    const keys = items.map((i) => i.projectKey)
    expect(keys).toContain('my-custom-project')
    // 旧 project 没有别的 session 了 → 应被清空
    expect(keys).not.toContain('moego-chrome-extension')
  })

  it('assign 后 confidence = 1.0（人工标记）', () => {
    const cur = getSession(home, 'cursor')
    assignSession(cur.id, 'manual-target', { homeDir: home })
    const items = listProjects({ homeDir: home })
    const target = items.find((i) => i.projectKey === 'manual-target')
    expect(target?.confidence).toBe(1)
  })

  it('未知 session-id → 抛错', () => {
    expect(() => assignSession('no-such-session', 'x', { homeDir: home })).toThrow(
      /session not found/,
    )
  })

  it('session-id 为空 → 抛错', () => {
    expect(() => assignSession('', 'x', { homeDir: home })).toThrow(/required/)
  })

  it('未初始化工作区 → 抛错', () => {
    const empty = makeTempHome()
    try {
      expect(() =>
        assignSession('any', 'x', { homeDir: empty }),
      ).toThrow(/workspace not initialized/)
    } finally {
      clean(empty)
    }
  })
})

// ─── mergeProjects ────────────────────────────────────────────────────────────

describe('mergeProjects', () => {
  let home: string
  beforeEach(async () => {
    home = makeTempHome()
    await setupScanned(home)
  })
  afterEach(() => clean(home))

  it('merge cloud-code-master → Boarding_Desktop：sessions 转移、from 项目消失', () => {
    const r = mergeProjects('cloud-code-master', 'Boarding_Desktop', { homeDir: home })
    expect(r.sessionsMoved).toBe(1)

    const items = listProjects({ homeDir: home })
    const keys = items.map((i) => i.projectKey)
    expect(keys).toContain('Boarding_Desktop')
    expect(keys).not.toContain('cloud-code-master')

    const merged = items.find((i) => i.projectKey === 'Boarding_Desktop')!
    expect(merged.sessionCount).toBe(2) // claude + codex
    expect(merged.agents.sort()).toEqual(['claude', 'codex'])
  })

  it('project_hints 也跟着迁移', () => {
    mergeProjects('cloud-code-master', 'Boarding_Desktop', { homeDir: home })
    const db = new Database(getDbPath(home), { readonly: true })
    const stillOld = (
      db
        .prepare("SELECT COUNT(*) AS c FROM project_hints WHERE project_key = 'cloud-code-master'")
        .get() as { c: number }
    ).c
    const newCount = (
      db
        .prepare("SELECT COUNT(*) AS c FROM project_hints WHERE project_key = 'Boarding_Desktop'")
        .get() as { c: number }
    ).c
    db.close()
    expect(stillOld).toBe(0)
    expect(newCount).toBeGreaterThan(0)
  })

  it('from == to → no-op，sessionsMoved=0', () => {
    const r = mergeProjects('Boarding_Desktop', 'Boarding_Desktop', { homeDir: home })
    expect(r.sessionsMoved).toBe(0)
  })

  it('from 不存在 → 抛错', () => {
    expect(() =>
      mergeProjects('nonexistent', 'Boarding_Desktop', { homeDir: home }),
    ).toThrow(/no sessions belong/)
  })

  it('merge 到不存在的 to → 自动创建该 project', () => {
    const r = mergeProjects('cloud-code-master', 'fresh-target', { homeDir: home })
    expect(r.sessionsMoved).toBe(1)
    const items = listProjects({ homeDir: home })
    const keys = items.map((i) => i.projectKey)
    expect(keys).toContain('fresh-target')
  })
})

// ─── reclassifyAll ────────────────────────────────────────────────────────────

describe('reclassifyAll', () => {
  let home: string
  beforeEach(async () => {
    home = makeTempHome()
    await setupScanned(home)
  })
  afterEach(() => clean(home))

  it('所有 session 已正确归类的状态下 → changed = 0，total = sessions 数', () => {
    const r = reclassifyAll({ homeDir: home })
    expect(r.total).toBeGreaterThanOrEqual(4)
    expect(r.changed).toBe(0)
  })

  it('先 assign 改一个，再 reclassify → 该 session 被还原回 hints 推断的 project', () => {
    const cur = getSession(home, 'cursor')
    assignSession(cur.id, 'manual-override', { homeDir: home })
    const items1 = listProjects({ homeDir: home })
    expect(items1.map((i) => i.projectKey)).toContain('manual-override')

    const r = reclassifyAll({ homeDir: home })
    expect(r.changed).toBeGreaterThanOrEqual(1)

    const items2 = listProjects({ homeDir: home })
    const keys = items2.map((i) => i.projectKey)
    expect(keys).toContain('moego-chrome-extension')
    expect(keys).not.toContain('manual-override')
  })

  it('--full 标志当前与默认行为相同（changed=0 当所有 session 已是 hints 推断结果）', () => {
    const r1 = reclassifyAll({ homeDir: home })
    const r2 = reclassifyAll({ homeDir: home, full: true })
    expect(r1.changed).toBe(0)
    expect(r2.changed).toBe(0)
  })

  it('reclassify 不改 project_hints 表的内容（hints 是不可变证据）', () => {
    const db1 = new Database(getDbPath(home), { readonly: true })
    const before = (
      db1.prepare('SELECT COUNT(*) AS c FROM project_hints').get() as { c: number }
    ).c
    db1.close()

    reclassifyAll({ homeDir: home })

    const db2 = new Database(getDbPath(home), { readonly: true })
    const after = (
      db2.prepare('SELECT COUNT(*) AS c FROM project_hints').get() as { c: number }
    ).c
    db2.close()

    expect(after).toBe(before)
  })
})
