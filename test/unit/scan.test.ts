import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInit } from '../../src/commands/init'
import { claudeAdapter } from '../../src/adapters/claude'
import { codexAdapter } from '../../src/adapters/codex'
import { copilotAdapter } from '../../src/adapters/copilot'
import { cursorAdapter } from '../../src/adapters/cursor'
import { runScan, determineScanState } from '../../src/scanner'
import { formatScanSummary } from '../../src/commands/scan'
import type { DiscoveredSession } from '../../src/types'

const SOURCES_DIR = path.resolve('test/sources')

describe('formatScanSummary', () => {
  it('以单行展示统计并省略值为 0 的可选状态', () => {
    expect(
      formatScanSummary({
        total: 681,
        new: 681,
        updated: 0,
        unchanged: 0,
        missing: 0,
        errors: 0,
      }),
    ).toBe('Sessions: 681 · New: 681 · Errors: 0')
  })
})

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

// ─── adapter probe ────────────────────────────────────────────────────────────

describe('claudeAdapter.probe', () => {
  it('正确目录 → matched true', async () => {
    const r = await claudeAdapter.probe(path.join(SOURCES_DIR, 'claude'))
    expect(r.matched).toBe(true)
  })

  it('cursor 目录（也有 projects/ 但结构不同） → matched false', async () => {
    const r = await claudeAdapter.probe(path.join(SOURCES_DIR, 'cursor'))
    expect(r.matched).toBe(false)
  })

  it('不存在的目录 → matched false', async () => {
    const r = await claudeAdapter.probe('/nonexistent/dir')
    expect(r.matched).toBe(false)
  })
})

describe('claudeAdapter.extractProjectHints', () => {
  it('从 jsonl 首行 cwd 抽出 cwd hint，值为 Boarding_Desktop 的完整路径', async () => {
    const sessions = await claudeAdapter.discover(path.join(SOURCES_DIR, 'claude'))
    expect(sessions.length).toBeGreaterThan(0)
    const hints = await claudeAdapter.extractProjectHints(sessions[0])
    const cwd = hints.find((h) => h.kind === 'cwd')
    expect(cwd).toBeDefined()
    expect(cwd!.value).toBe('/Users/moego-winches/Desktop/Company/Moe/Boarding_Desktop')
    expect(cwd!.agent).toBe('claude')
    expect(cwd!.source).toBe('metadata')
    expect(cwd!.confidence).toBeGreaterThan(0.8)
  })

  it('从 sourcePath 中的 projects/<encoded> 抽出 source_project_path hint', async () => {
    const sessions = await claudeAdapter.discover(path.join(SOURCES_DIR, 'claude'))
    const hints = await claudeAdapter.extractProjectHints(sessions[0])
    const spp = hints.find((h) => h.kind === 'source_project_path')
    expect(spp).toBeDefined()
    expect(spp!.value).toContain('Boarding')
    expect(spp!.source).toBe('source_path')
  })
})

describe('codexAdapter.probe', () => {
  it('正确目录 → matched true', async () => {
    const r = await codexAdapter.probe(path.join(SOURCES_DIR, 'codex'))
    expect(r.matched).toBe(true)
  })

  it('claude 目录 → matched false', async () => {
    const r = await codexAdapter.probe(path.join(SOURCES_DIR, 'claude'))
    expect(r.matched).toBe(false)
  })

  it('不存在的目录 → matched false', async () => {
    const r = await codexAdapter.probe('/nonexistent/dir')
    expect(r.matched).toBe(false)
  })
})

describe('codexAdapter.extractProjectHints', () => {
  it('从 session_meta.payload.cwd 抽出 cwd hint = cloud-code-master 完整路径', async () => {
    const sessions = await codexAdapter.discover(path.join(SOURCES_DIR, 'codex'))
    expect(sessions.length).toBeGreaterThan(0)
    const hints = await codexAdapter.extractProjectHints(sessions[0])
    const cwd = hints.find((h) => h.kind === 'cwd')
    expect(cwd).toBeDefined()
    expect(cwd!.value).toBe('/Users/moego-winches/Desktop/Company/person/cloud-code-master')
    expect(cwd!.agent).toBe('codex')
    expect(cwd!.source).toBe('metadata')
  })
})

describe('copilotAdapter.probe', () => {
  it('正确目录 → matched true', async () => {
    const r = await copilotAdapter.probe(path.join(SOURCES_DIR, 'copilot'))
    expect(r.matched).toBe(true)
  })

  it('codex 目录 → matched false', async () => {
    const r = await copilotAdapter.probe(path.join(SOURCES_DIR, 'codex'))
    expect(r.matched).toBe(false)
  })

  it('不存在的目录 → matched false', async () => {
    const r = await copilotAdapter.probe('/nonexistent/dir')
    expect(r.matched).toBe(false)
  })
})

describe('copilotAdapter.extractProjectHints', () => {
  it('从 session.start.data.context 抽出 cwd / git_root / branch 三种 hint', async () => {
    const sessions = await copilotAdapter.discover(path.join(SOURCES_DIR, 'copilot'))
    expect(sessions.length).toBeGreaterThan(0)
    const hints = await copilotAdapter.extractProjectHints(sessions[0])

    const cwd = hints.find((h) => h.kind === 'cwd')
    const gitRoot = hints.find((h) => h.kind === 'git_root')
    const branch = hints.find((h) => h.kind === 'branch')

    expect(cwd?.value).toBe('/Users/moego-winches/Desktop/Company/person/agent-memory-system')
    expect(gitRoot?.value).toBe('/Users/moego-winches/Desktop/Company/person/agent-memory-system')
    expect(branch?.value).toBe('main')

    expect(gitRoot?.confidence).toBeGreaterThan(cwd!.confidence)
    expect(branch?.confidence).toBeLessThan(cwd!.confidence)
  })
})

describe('cursorAdapter.probe', () => {
  it('正确目录 → matched true', async () => {
    const r = await cursorAdapter.probe(path.join(SOURCES_DIR, 'cursor'))
    expect(r.matched).toBe(true)
  })

  it('claude 目录（也有 projects/ 但无 agent-transcripts/） → matched false', async () => {
    const r = await cursorAdapter.probe(path.join(SOURCES_DIR, 'claude'))
    expect(r.matched).toBe(false)
  })

  it('不存在的目录 → matched false', async () => {
    const r = await cursorAdapter.probe('/nonexistent/dir')
    expect(r.matched).toBe(false)
  })
})

describe('cursorAdapter.extractProjectHints', () => {
  it('从 sourcePath 中的 projects/<encoded> 抽出 source_project_path hint = moego-chrome-extension', async () => {
    const sessions = await cursorAdapter.discover(path.join(SOURCES_DIR, 'cursor'))
    expect(sessions.length).toBeGreaterThan(0)
    const hints = await cursorAdapter.extractProjectHints(sessions[0])
    const spp = hints.find((h) => h.kind === 'source_project_path')
    expect(spp).toBeDefined()
    expect(spp!.value).toContain('moego-chrome-extension')
    expect(spp!.agent).toBe('cursor')
    expect(spp!.source).toBe('source_path')
  })
})

// ─── runScan integration ──────────────────────────────────────────────────────

describe('runScan --source test/sources --all', () => {
  let home: string

  beforeEach(async () => {
    home = makeTempHome()
    await runInit({ nonInteractive: true, homeDir: home })
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

  it('通过回调报告 agent 的发现、处理和完成进度', async () => {
    const progress: Array<{
      agent: string
      phase: string
      current?: number
      total?: number
    }> = []
    const options = {
      source: SOURCES_DIR,
      agents: ['codex'],
      homeDir: home,
      onProgress: (event: (typeof progress)[number]) => {
        progress.push(event)
      },
    } as Parameters<typeof runScan>[0]

    await runScan(options)

    expect(progress).toContainEqual({ agent: 'codex', phase: 'discovering' })
    expect(progress).toContainEqual(
      expect.objectContaining({ agent: 'codex', phase: 'processing', current: 0 }),
    )
    expect(progress).toContainEqual(
      expect.objectContaining({ agent: 'codex', phase: 'done', current: expect.any(Number) }),
    )
    const done = progress.find((event) => event.phase === 'done')
    expect(done?.current).toBe(done?.total)
  })

  it('等待异步 progress 回调完成后再继续扫描', async () => {
    let loadingPainted = false
    let paintedBeforeProcessing = false
    const options = {
      source: SOURCES_DIR,
      agents: ['codex'],
      homeDir: home,
      onProgress: async (event: { phase: string }) => {
        if (event.phase === 'discovering') {
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              loadingPainted = true
              resolve()
            }, 5)
          })
        }
        if (event.phase === 'processing') paintedBeforeProcessing = loadingPainted
      },
    } as Parameters<typeof runScan>[0]

    await runScan(options)

    expect(paintedBeforeProcessing).toBe(true)
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
    await runInit({ nonInteractive: true, homeDir: home })
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
    await runInit({ nonInteractive: true, homeDir: home })
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
