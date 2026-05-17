import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runInit } from '../../src/commands/init'
import { runScan } from '../../src/scanner'
import {
  assignSession,
  mergeProjects,
  reclassifyAll,
  listProjects,
} from '../../src/projects'
import { getDbPath } from '../../src/db'
import { resolveWorkspace } from '../../src/workspace'
import { listLinks } from '../../src/fs-writer'

const SOURCES_DIR = path.resolve('test/sources')

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pm-'))
}
function clean(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

async function setupScanned(home: string): Promise<void> {
  await runInit({ yes: true, homeDir: home })
  await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
}

function getSession(home: string, agent: string): { id: string; slug: string } {
  const db = new Database(getDbPath(home), { readonly: true })
  const row = db
    .prepare('SELECT id, slug FROM sessions WHERE agent = ? LIMIT 1')
    .get(agent) as { id: string; slug: string }
  db.close()
  return row
}

function fsHas(workspaceDir: string, slug: string, sessionId: string): boolean {
  return fs.existsSync(
    path.join(workspaceDir, 'projects', slug, `${sessionId}.jsonl`),
  )
}

// ─── assignSession ────────────────────────────────────────────────────────────

describe('assignSession', () => {
  let home: string
  let workspaceDir: string
  beforeEach(async () => {
    home = makeTempHome()
    workspaceDir = resolveWorkspace(home).workspaceDir
    await setupScanned(home)
  })
  afterEach(() => clean(home))

  it('改 slug：旧 link 删 + 新 link 建 + sessions.slug 更新', () => {
    const cur = getSession(home, 'cursor')
    expect(fsHas(workspaceDir, cur.slug, cur.id)).toBe(true)

    const r = assignSession(cur.id, 'my-custom', { homeDir: home })
    expect(r.previousSlug).toBe(cur.slug)
    expect(r.newSlug).toBe('my-custom')

    // FS
    expect(fsHas(workspaceDir, 'my-custom', cur.id)).toBe(true)
    expect(fsHas(workspaceDir, cur.slug, cur.id)).toBe(false)
    // DB
    const updated = getSession(home, 'cursor')
    // 注意 cursor agent 不只一个，但 cur.id 那行肯定改了
    const db = new Database(getDbPath(home), { readonly: true })
    const slug = (db
      .prepare('SELECT slug FROM sessions WHERE id = ?')
      .get(cur.id) as { slug: string }).slug
    db.close()
    expect(slug).toBe('my-custom')
  })

  it('slug 相同 → no-op', () => {
    const cur = getSession(home, 'cursor')
    const r = assignSession(cur.id, cur.slug, { homeDir: home })
    expect(r.previousSlug).toBe(r.newSlug)
  })

  it('未知 sessionId → 抛错', () => {
    expect(() =>
      assignSession('no-such-session', 'x', { homeDir: home }),
    ).toThrow(/session not found/)
  })

  it('空 sessionId → 抛错', () => {
    expect(() => assignSession('', 'x', { homeDir: home })).toThrow(/required/)
  })

  it('未初始化工作区 → 抛错', () => {
    const empty = makeTempHome()
    try {
      expect(() => assignSession('any', 'x', { homeDir: empty })).toThrow(
        /workspace not initialized/,
      )
    } finally {
      clean(empty)
    }
  })
})

// ─── mergeProjects ────────────────────────────────────────────────────────────

describe('mergeProjects', () => {
  let home: string
  let workspaceDir: string
  beforeEach(async () => {
    home = makeTempHome()
    workspaceDir = resolveWorkspace(home).workspaceDir
    await setupScanned(home)
  })
  afterEach(() => clean(home))

  it('合并：from 全部 session mv 到 to + from 目录消失', () => {
    const r = mergeProjects('cloud-code-master', 'boarding-desktop', { homeDir: home })
    expect(r.sessionsMoved).toBeGreaterThanOrEqual(1)

    // FS：from 目录被清理
    expect(
      fs.existsSync(path.join(workspaceDir, 'projects', 'cloud-code-master')),
    ).toBe(false)

    // listProjects 不应再出现 cloud-code-master
    const items = listProjects({ homeDir: home })
    const keys = items.map((i) => i.slug)
    expect(keys).not.toContain('cloud-code-master')
    expect(keys).toContain('boarding-desktop')
  })

  it('from == to → no-op，sessionsMoved=0', () => {
    const r = mergeProjects('boarding-desktop', 'boarding-desktop', { homeDir: home })
    expect(r.sessionsMoved).toBe(0)
  })

  it('from 不存在 → 抛错', () => {
    expect(() =>
      mergeProjects('nonexistent-slug', 'boarding-desktop', { homeDir: home }),
    ).toThrow(/no sessions belong/)
  })

  it('merge 到不存在的 to → 自动创建', () => {
    const r = mergeProjects('cloud-code-master', 'fresh-target', { homeDir: home })
    expect(r.sessionsMoved).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(path.join(workspaceDir, 'projects', 'fresh-target'))).toBe(true)
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

  it('干净状态 → changed = 0，total ≥ 4', async () => {
    const r = await reclassifyAll({ homeDir: home })
    expect(r.total).toBeGreaterThanOrEqual(4)
    expect(r.changed).toBe(0)
  })

  it('先 assign 偏移再 reclassify → 该 session 被还原', async () => {
    const cur = getSession(home, 'cursor')
    const originalSlug = cur.slug
    assignSession(cur.id, 'manual-offset', { homeDir: home })

    const r = await reclassifyAll({ homeDir: home })
    expect(r.changed).toBeGreaterThanOrEqual(1)

    const db = new Database(getDbPath(home), { readonly: true })
    const slug = (db
      .prepare('SELECT slug FROM sessions WHERE id = ?')
      .get(cur.id) as { slug: string }).slug
    db.close()
    expect(slug).toBe(originalSlug)
  })

  it('--full 当前等价默认（changed=0 干净状态）', async () => {
    const r1 = await reclassifyAll({ homeDir: home })
    const r2 = await reclassifyAll({ homeDir: home, full: true })
    expect(r1.changed).toBe(0)
    expect(r2.changed).toBe(0)
  })

  it('未初始化工作区 → 抛错', async () => {
    const empty = makeTempHome()
    try {
      await expect(reclassifyAll({ homeDir: empty })).rejects.toThrow(
        /workspace not initialized/,
      )
    } finally {
      clean(empty)
    }
  })
})

// ─── 复合：listLinks 与 DB sessions.slug 双向一致 ─────────────────────────────

describe('FS / DB 双向一致性（mutations 后）', () => {
  let home: string
  let workspaceDir: string
  beforeEach(async () => {
    home = makeTempHome()
    workspaceDir = resolveWorkspace(home).workspaceDir
    await setupScanned(home)
  })
  afterEach(() => clean(home))

  it('assign + merge + reclassify 任意组合后 FS 与 DB 仍一致', async () => {
    const cur = getSession(home, 'cursor')
    assignSession(cur.id, 'X', { homeDir: home })
    mergeProjects('X', 'Y', { homeDir: home })
    await reclassifyAll({ homeDir: home })

    const links = listLinks(workspaceDir)
    const fsMap = new Map<string, string>()
    for (const [slug, sids] of links) for (const s of sids) fsMap.set(s, slug)

    const db = new Database(getDbPath(home), { readonly: true })
    const rows = db.prepare('SELECT id, slug FROM sessions').all() as Array<{
      id: string
      slug: string
    }>
    db.close()

    for (const r of rows) {
      expect(fsMap.get(r.id)).toBe(r.slug)
    }
  })
})
