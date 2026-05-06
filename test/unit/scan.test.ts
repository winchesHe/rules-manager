import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInit } from '../../src/commands/init'
import { claudeAdapter } from '../../src/adapters/claude'
import { codexAdapter } from '../../src/adapters/codex'
import { copilotAdapter } from '../../src/adapters/copilot'
import { cursorAdapter } from '../../src/adapters/cursor'
import { runScan, determineScanState } from '../../src/scanner'
import type { DiscoveredSession } from '../../src/types'

const SOURCES_DIR = path.resolve('test/sources')

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-scan-test-'))
}

function makeTempSources(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-scan-src-'))
  fs.cpSync(SOURCES_DIR, dir, { recursive: true })
  return dir
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

// ─── determineScanState 单元测试 ──────────────────────────────────────────────

describe('determineScanState', () => {
  const discovered: DiscoveredSession = {
    id: 'session-x',
    agent: 'claude',
    sourcePath: '/tmp/x.jsonl',
    sourceKind: 'jsonl',
    updatedAt: '2026-05-01T00:00:00.000Z',
    contentHash: 'hash-current',
  }

  it('DB 无记录 → new', () => {
    expect(determineScanState(discovered, undefined)).toBe('new')
  })

  it('content_hash 不同 → updated', () => {
    expect(
      determineScanState(discovered, {
        id: 'session-x',
        updated_at: '2026-05-01T00:00:00.000Z',
        content_hash: 'hash-old',
      }),
    ).toBe('updated')
  })

  it('updated_at 不同 → updated', () => {
    expect(
      determineScanState(discovered, {
        id: 'session-x',
        updated_at: '2026-04-01T00:00:00.000Z',
        content_hash: 'hash-current',
      }),
    ).toBe('updated')
  })

  it('两者都相同 → unchanged', () => {
    expect(
      determineScanState(discovered, {
        id: 'session-x',
        updated_at: '2026-05-01T00:00:00.000Z',
        content_hash: 'hash-current',
      }),
    ).toBe('unchanged')
  })
})

// ─── runScan 集成（updated / missing / --full） ────────────────────────────────

describe('runScan: updated / missing 分类', () => {
  let home: string
  let sources: string

  beforeEach(async () => {
    home = makeTempHome()
    sources = makeTempSources()
    await runInit({ yes: true, homeDir: home })
  })

  afterEach(() => {
    cleanHome(home)
    cleanHome(sources)
  })

  it('修改 codex 单个 session 文件后 → 至少 1 条 updated', async () => {
    await runScan({ source: sources, all: true, homeDir: home })

    const codexFile = path.join(
      sources,
      'codex/sessions/2026/04/rollout-2026-04-07T00-05-53-019d638b-1936-7f31-a505-a38278eebe9d.jsonl',
    )
    expect(fs.existsSync(codexFile)).toBe(true)

    fs.appendFileSync(codexFile, '\n{"type":"event","timestamp":"2026-05-06T00:00:00.000Z"}\n')
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(codexFile, future, future)

    const summary = await runScan({ source: sources, all: true, homeDir: home })
    expect(summary.updated).toBeGreaterThanOrEqual(1)
    expect(summary.errors).toBe(0)
  })

  it('删除 codex session 文件后 → 至少 1 条 missing', async () => {
    await runScan({ source: sources, all: true, homeDir: home })

    const codexFile = path.join(
      sources,
      'codex/sessions/2026/04/rollout-2026-04-07T00-05-53-019d638b-1936-7f31-a505-a38278eebe9d.jsonl',
    )
    fs.rmSync(codexFile)

    const summary = await runScan({ source: sources, all: true, homeDir: home })
    expect(summary.missing).toBeGreaterThanOrEqual(1)
    expect(summary.errors).toBe(0)
  })

  it('已 missing 的 session 重复扫描不再被计入 summary.missing', async () => {
    await runScan({ source: sources, all: true, homeDir: home })

    const codexFile = path.join(
      sources,
      'codex/sessions/2026/04/rollout-2026-04-07T00-05-53-019d638b-1936-7f31-a505-a38278eebe9d.jsonl',
    )
    fs.rmSync(codexFile)

    const first = await runScan({ source: sources, all: true, homeDir: home })
    expect(first.missing).toBeGreaterThanOrEqual(1)

    const second = await runScan({ source: sources, all: true, homeDir: home })
    expect(second.missing).toBe(0)
  })
})

describe('runScan --full', () => {
  let home: string

  beforeEach(async () => {
    home = makeTempHome()
    await runInit({ yes: true, homeDir: home })
  })

  afterEach(() => {
    cleanHome(home)
  })

  it('--full 等价于 --all：全部内置 agent 都被扫描', async () => {
    const summary = await runScan({ source: SOURCES_DIR, full: true, homeDir: home })
    expect(summary.total).toBeGreaterThanOrEqual(4)
    expect(summary.errors).toBe(0)
  })
})
