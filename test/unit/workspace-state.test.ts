import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveWorkspace } from '../../src/workspace'
import { initDatabase, isDatabaseReady } from '../../src/db'
import { runInit } from '../../src/commands/init'
import { runStatus } from '../../src/commands/status'

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-test-'))
}

function cleanHome(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

// ─── workspace ───────────────────────────────────────────────────────────────

describe('resolveWorkspace', () => {
  it('应使用给定 homeDir 构造路径', () => {
    const home = makeTempHome()
    const ws = resolveWorkspace(home)
    expect(ws.workspaceDir).toBe(path.join(home, '.memory-manager'))
    expect(ws.dbPath).toBe(path.join(home, '.memory-manager', 'memory.db'))
    expect(ws.projectsDir).toBe(path.join(home, '.memory-manager', 'rules', 'projects'))
    cleanHome(home)
  })
})

// ─── init ────────────────────────────────────────────────────────────────────

describe('runInit --yes', () => {
  let home: string

  beforeEach(() => {
    home = makeTempHome()
  })

  afterEach(() => {
    cleanHome(home)
  })

  it('应创建 ~/.memory-manager/', async () => {
    await runInit({ yes: true, homeDir: home })
    const ws = resolveWorkspace(home)
    expect(fs.existsSync(ws.workspaceDir)).toBe(true)
  })

  it('应创建 ~/.memory-manager/rules/projects/', async () => {
    await runInit({ yes: true, homeDir: home })
    const ws = resolveWorkspace(home)
    expect(fs.existsSync(ws.projectsDir)).toBe(true)
  })

  it('应创建 ~/.memory-manager/memory.db', async () => {
    await runInit({ yes: true, homeDir: home })
    const ws = resolveWorkspace(home)
    expect(fs.existsSync(ws.dbPath)).toBe(true)
  })

  it('不应创建 config.toml', async () => {
    await runInit({ yes: true, homeDir: home })
    const ws = resolveWorkspace(home)
    expect(fs.existsSync(path.join(ws.workspaceDir, 'config.toml'))).toBe(false)
  })

  it('不应创建 logs/ 目录', async () => {
    await runInit({ yes: true, homeDir: home })
    const ws = resolveWorkspace(home)
    expect(fs.existsSync(path.join(ws.workspaceDir, 'logs'))).toBe(false)
  })

  it('不应创建 cache/ 目录', async () => {
    await runInit({ yes: true, homeDir: home })
    const ws = resolveWorkspace(home)
    expect(fs.existsSync(path.join(ws.workspaceDir, 'cache'))).toBe(false)
  })

  it('不应创建 snapshots/ 目录', async () => {
    await runInit({ yes: true, homeDir: home })
    const ws = resolveWorkspace(home)
    expect(fs.existsSync(path.join(ws.workspaceDir, 'snapshots'))).toBe(false)
  })

  it('应可以幂等执行两次', async () => {
    await runInit({ yes: true, homeDir: home })
    await expect(runInit({ yes: true, homeDir: home })).resolves.not.toThrow()
    const ws = resolveWorkspace(home)
    expect(fs.existsSync(ws.dbPath)).toBe(true)
  })

  it('init 后 isDatabaseReady 应为 true', async () => {
    await runInit({ yes: true, homeDir: home })
    expect(isDatabaseReady(home)).toBe(true)
  })
})

// ─── status ──────────────────────────────────────────────────────────────────

describe('runStatus', () => {
  let home: string
  let output: string[]
  let origLog: typeof console.log

  beforeEach(() => {
    home = makeTempHome()
    output = []
    origLog = console.log
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }
  })

  afterEach(() => {
    console.log = origLog
    cleanHome(home)
  })

  it('初始化前：Database 和 Rules dir 应为 not initialized', () => {
    runStatus({ homeDir: home })
    expect(output.some((l) => l.includes('Database: not initialized'))).toBe(true)
    expect(output.some((l) => l.includes('Rules dir: not initialized'))).toBe(true)
  })

  it('初始化后：应输出四行验收文本', async () => {
    await runInit({ yes: true, homeDir: home })
    output = []

    // 暂时替换 HOME 使 status 能正确替换 ~ 路径
    const origHome = process.env.HOME
    process.env.HOME = home
    runStatus({ homeDir: home })
    process.env.HOME = origHome

    expect(output.some((l) => l.startsWith('Home: ~/.memory-manager'))).toBe(true)
    expect(output.some((l) => l === 'Database: ready')).toBe(true)
    expect(output.some((l) => l === 'Rules dir: ready')).toBe(true)
    expect(output.some((l) => l === 'Configured agents: auto-detect')).toBe(true)
  })
})

// ─── DB schema ───────────────────────────────────────────────────────────────

describe('initDatabase schema', () => {
  let home: string

  beforeEach(() => {
    home = makeTempHome()
    // 需要先创建目录
    const ws = resolveWorkspace(home)
    fs.mkdirSync(ws.workspaceDir, { recursive: true })
  })

  afterEach(() => {
    cleanHome(home)
  })

  it('应包含 sessions 表', () => {
    const db = initDatabase(home)
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get()
    db.close()
    expect(row).toBeTruthy()
  })

  it('应包含 rule_candidates 表', () => {
    const db = initDatabase(home)
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rule_candidates'")
      .get()
    db.close()
    expect(row).toBeTruthy()
  })

  it('不应保存完整 content 字段（sessions 表无 content 列）', () => {
    const db = initDatabase(home)
    const cols = db.pragma('table_info(sessions)') as Array<{ name: string }>
    db.close()
    const hasContent = cols.some((c) => c.name === 'content')
    expect(hasContent).toBe(false)
  })

  it('sessions 表应只含允许字段', () => {
    const db = initDatabase(home)
    const cols = db.pragma('table_info(sessions)') as Array<{ name: string }>
    db.close()
    const allowed = new Set(['id', 'agent', 'source_path', 'updated_at', 'content_hash', 'project_key'])
    for (const col of cols) {
      expect(allowed.has(col.name)).toBe(true)
    }
  })
})
