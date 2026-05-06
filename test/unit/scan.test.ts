import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInit } from '../../src/commands/init'
import { claudeAdapter } from '../../src/adapters/claude'
import { codexAdapter } from '../../src/adapters/codex'
import { copilotAdapter } from '../../src/adapters/copilot'
import { cursorAdapter } from '../../src/adapters/cursor'
import { runScan } from '../../src/scanner'

const SOURCES_DIR = path.resolve('test/sources')

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-scan-test-'))
}

function cleanHome(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

// ─── adapter discover ─────────────────────────────────────────────────────────

describe('copilotAdapter.discover', () => {
  it('应发现至少 1 个 session', async () => {
    const sessions = await copilotAdapter.discover(path.join(SOURCES_DIR, 'copilot'))
    expect(sessions.length).toBeGreaterThanOrEqual(1)
    expect(sessions[0].agent).toBe('copilot')
    expect(sessions[0].id).toBeTruthy()
    expect(sessions[0].contentHash).toBeTruthy()
    expect(sessions[0].sourcePath).toBeTruthy()
  })

  it('源目录不存在时应返回空数组', async () => {
    const sessions = await copilotAdapter.discover('/nonexistent/dir')
    expect(sessions).toEqual([])
  })
})

describe('codexAdapter.discover', () => {
  it('应发现至少 1 个 session', async () => {
    const sessions = await codexAdapter.discover(path.join(SOURCES_DIR, 'codex'))
    expect(sessions.length).toBeGreaterThanOrEqual(1)
    expect(sessions[0].agent).toBe('codex')
    expect(sessions[0].id).toBeTruthy()
    expect(sessions[0].contentHash).toBeTruthy()
  })

  it('源目录不存在时应返回空数组', async () => {
    const sessions = await codexAdapter.discover('/nonexistent/dir')
    expect(sessions).toEqual([])
  })
})

describe('claudeAdapter.discover', () => {
  it('应发现至少 1 个 session', async () => {
    const sessions = await claudeAdapter.discover(path.join(SOURCES_DIR, 'claude'))
    expect(sessions.length).toBeGreaterThanOrEqual(1)
    expect(sessions[0].agent).toBe('claude')
    expect(sessions[0].id).toBeTruthy()
    expect(sessions[0].contentHash).toBeTruthy()
  })

  it('源目录不存在时应返回空数组', async () => {
    const sessions = await claudeAdapter.discover('/nonexistent/dir')
    expect(sessions).toEqual([])
  })
})

describe('cursorAdapter.discover', () => {
  it('应发现至少 1 个 session', async () => {
    const sessions = await cursorAdapter.discover(path.join(SOURCES_DIR, 'cursor'))
    expect(sessions.length).toBeGreaterThanOrEqual(1)
    expect(sessions[0].agent).toBe('cursor')
    expect(sessions[0].id).toBeTruthy()
    expect(sessions[0].contentHash).toBeTruthy()
  })

  it('源目录不存在时应返回空数组', async () => {
    const sessions = await cursorAdapter.discover('/nonexistent/dir')
    expect(sessions).toEqual([])
  })
})

// ─── runScan integration ──────────────────────────────────────────────────────

describe('runScan --source test/sources --all', () => {
  let home: string

  beforeEach(async () => {
    home = makeTempHome()
    await runInit({ yes: true, homeDir: home })
  })

  afterEach(() => {
    cleanHome(home)
  })

  it('第一次扫描：total >= 4, new >= 4, errors = 0', async () => {
    const summary = await runScan({
      source: SOURCES_DIR,
      all: true,
      homeDir: home,
    })
    expect(summary.total).toBeGreaterThanOrEqual(4)
    expect(summary.new).toBeGreaterThanOrEqual(4)
    expect(summary.errors).toBe(0)
  })

  it('第二次扫描：全为 unchanged，new = 0，updated = 0，errors = 0', async () => {
    await runScan({ source: SOURCES_DIR, all: true, homeDir: home })

    const summary = await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
    expect(summary.unchanged).toBe(summary.total)
    expect(summary.new).toBe(0)
    expect(summary.updated).toBe(0)
    expect(summary.errors).toBe(0)
  })

  it('扫描结果 total = new + updated + unchanged（无 missing/error 时）', async () => {
    const summary = await runScan({ source: SOURCES_DIR, all: true, homeDir: home })
    expect(summary.new + summary.updated + summary.unchanged).toBe(summary.total)
  })
})
