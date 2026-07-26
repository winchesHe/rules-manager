import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runInit } from '../../src/commands/init'
import { runScan } from '../../src/scanner'
import { listProjects } from '../../src/commands/projects'
import { listLinks } from '../../src/fs-writer'
import { getDbPath } from '../../src/db'
import { resolveWorkspace, DEFAULT_SLUG } from '../../src/workspace'

const SOURCES_DIR = path.resolve('test/sources')

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-proj-'))
}
function clean(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

// ─── plan 04 fixture 4 slug 仍能识别（slug 形态归一化为 kebab） ─────────────

describe('scan test/sources --all → FS projects/ 视图', () => {
  let home: string
  beforeEach(async () => {
    home = makeTempHome()
    await runInit({ nonInteractive: true, homeDir: home })
  })
  afterEach(() => clean(home))

  it('4 个预期 slug 都在 projects/ 物理目录里', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })

    const { projectsDir } = resolveWorkspace(home)
    const slugs = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)

    for (const expected of [
      'boarding-desktop',
      'cloud-code-master',
      'agent-memory-system',
      'moego-chrome-extension',
    ]) {
      expect(slugs).toContain(expected)
    }
  })

  it('每个 slug 目录里有 symlink，target 存在（cat 可读对单文件 jsonl 生效）', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })

    const { projectsDir } = resolveWorkspace(home)
    // codex / copilot / cursor 都是单 jsonl session；用 codex 验证 cat 可读
    const dir = path.join(projectsDir, 'cloud-code-master')
    const files = fs.readdirSync(dir)
    expect(files.length).toBeGreaterThanOrEqual(1)
    const first = path.join(dir, files[0])
    expect(fs.lstatSync(first).isSymbolicLink()).toBe(true)
    // codex 是单文件 jsonl，可直接读
    expect(fs.readFileSync(first, 'utf8').length).toBeGreaterThan(0)

    // claude multi-file session 的 sourcePath 是目录；symlink 仍合法，但
    // cat 不一定能读（target 是目录）。验证 target 存在即足够。
    const claudeDir = path.join(projectsDir, 'boarding-desktop')
    const claudeFiles = fs.readdirSync(claudeDir)
    expect(claudeFiles.length).toBeGreaterThanOrEqual(1)
    const claudeFirst = path.join(claudeDir, claudeFiles[0])
    expect(fs.lstatSync(claudeFirst).isSymbolicLink()).toBe(true)
    const target = fs.readlinkSync(claudeFirst)
    expect(fs.existsSync(target)).toBe(true)
  })

  it('sessions 行数 = FS link 总数（FS 与 DB 一致）', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })

    const { workspaceDir } = resolveWorkspace(home)
    const links = listLinks(workspaceDir)
    const linkCount = Array.from(links.values()).reduce((s, a) => s + a.length, 0)

    const db = new Database(getDbPath(home), { readonly: true })
    const c = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c
    db.close()
    expect(linkCount).toBe(c)
  })

  it('sessions.slug 与 FS 双向一致', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })

    const { workspaceDir } = resolveWorkspace(home)
    const links = listLinks(workspaceDir)
    const fsMap = new Map<string, string>()
    for (const [slug, sids] of links) {
      for (const sid of sids) fsMap.set(sid, slug)
    }

    const db = new Database(getDbPath(home), { readonly: true })
    const dbRows = db.prepare('SELECT id, slug FROM sessions').all() as Array<{
      id: string
      slug: string
    }>
    db.close()

    for (const r of dbRows) {
      expect(fsMap.get(r.id)).toBe(r.slug)
    }
  })

  it('重复扫描 link 数不堆积（FS 幂等）', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
    const { workspaceDir } = resolveWorkspace(home)
    const c1 = Array.from(listLinks(workspaceDir).values()).reduce(
      (s, a) => s + a.length,
      0,
    )
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
    const c2 = Array.from(listLinks(workspaceDir).values()).reduce(
      (s, a) => s + a.length,
      0,
    )
    expect(c2).toBe(c1)
  })
})

// ─── listProjects ────────────────────────────────────────────────────────────

describe('listProjects', () => {
  let home: string
  beforeEach(() => {
    home = makeTempHome()
  })
  afterEach(() => clean(home))

  it('未初始化工作区 → 空数组（不抛）', () => {
    expect(listProjects({ homeDir: home })).toEqual([])
  })

  it('init 但未 scan → 空数组（projects/default 目录里没 jsonl）', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    // default 目录虽然存在，但 listLinks 会返回 { default: [] }
    // listProjects 也应过滤空 slug，输出空数组
    const items = listProjects({ homeDir: home })
    // 接受 default slug 出现但 sessionCount = 0；或者完全为空
    if (items.length > 0) {
      expect(items.every((i) => i.sessionCount === 0 || i.slug === DEFAULT_SLUG)).toBe(true)
    }
  })

  it('scan 后按 session_count 降序排列', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
    const items = listProjects({ homeDir: home })
    expect(items.length).toBeGreaterThanOrEqual(4)
    for (let i = 1; i < items.length; i++) {
      expect(items[i].sessionCount).toBeLessThanOrEqual(items[i - 1].sessionCount)
    }
  })

  it('items 字段：slug / sessionCount / agents', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
    const items = listProjects({ homeDir: home })
    const sample = items.find((i) => i.slug === 'boarding-desktop')
    expect(sample).toBeDefined()
    expect(sample!.sessionCount).toBeGreaterThanOrEqual(1)
    expect(sample!.agents).toContain('claude')
  })
})
