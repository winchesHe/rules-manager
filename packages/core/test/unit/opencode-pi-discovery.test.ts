import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { opencodeAdapter } from '../../src/adapters/opencode'
import { piAdapter } from '../../src/adapters/pi'
import { runInit } from '../../src/commands/init'
import { initDatabase } from '../../src/db'
import { runScan } from '../../src/scanner'

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-opencode-pi-'))
}

function createOpenCodeDb(sourceDir: string): string {
  fs.mkdirSync(sourceDir, { recursive: true })
  const dbPath = path.join(sourceDir, 'opencode.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      parent_id TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
  const insert = db.prepare(
    `INSERT INTO session
      (id, directory, title, parent_id, time_created, time_updated, time_archived)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  insert.run('ses_root_active', '/tmp/open-active', 'active', null, 1000, 2000, null)
  insert.run('ses_root_archived', '/tmp/open-archived', 'archived', null, 3000, 4000, 5000)
  insert.run('ses_child', '/tmp/open-active', 'child', 'ses_root_active', 1500, 2500, null)
  db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
  ).run('msg_1', 'ses_root_active', 1100, 1200, '{"role":"user"}')
  db.close()
  return dbPath
}

function writePiSession(filePath: string, id: string, cwd: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    [
      { type: 'session', version: 3, id, timestamp: '2026-07-24T01:00:00.000Z', cwd },
      {
        type: 'message',
        id: 'user-1',
        timestamp: '2026-07-24T01:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'test' }] },
      },
      {
        type: 'message',
        id: 'assistant-1',
        timestamp: '2026-07-24T01:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'read' }, { type: 'text', text: 'ok' }],
        },
      },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n',
  )
}

describe('OpenCode adapter', () => {
  let home: string

  beforeEach(() => {
    home = makeTempHome()
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('从 opencode.db 发现 active + archived root sessions，排除 child', async () => {
    const source = path.join(home, '.local', 'share', 'opencode')
    const dbPath = createOpenCodeDb(source)

    const sessions = await opencodeAdapter.discover(source)

    expect(sessions.map((session) => session.id).sort()).toEqual([
      'ses_root_active',
      'ses_root_archived',
    ])
    expect(sessions.every((session) => session.sourcePath === dbPath)).toBe(true)
    expect(sessions.every((session) => session.sourceKind === 'sqlite')).toBe(true)
    expect(sessions[0].contentHash).not.toBe(sessions[1].contentHash)
  })

  it('只读取 session 元数据与消息计数，不读取消息 data', async () => {
    const source = path.join(home, '.local', 'share', 'opencode')
    createOpenCodeDb(source)
    const sessions = await opencodeAdapter.discover(source)
    const active = sessions.find((session) => session.id === 'ses_root_active')!

    const parsed = await opencodeAdapter.parse(active)
    const hints = await opencodeAdapter.extractProjectHints(active)

    expect(parsed.messageCount).toBe(1)
    expect(parsed.metadata.cwd).toBe('/tmp/open-active')
    expect(hints).toContainEqual(
      expect.objectContaining({ kind: 'cwd', value: '/tmp/open-active', agent: 'opencode' }),
    )
  })
})

describe('Pi adapter', () => {
  let home: string

  beforeEach(() => {
    home = makeTempHome()
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('递归扫描合法 session JSONL 并忽略无 header 噪声', async () => {
    const source = path.join(home, '.pi', 'agent')
    const sessionFile = path.join(source, 'sessions', 'encoded-project', 'session.jsonl')
    writePiSession(sessionFile, 'pi-session-1', '/tmp/pi-project')
    fs.writeFileSync(path.join(source, 'sessions', 'noise.jsonl'), '{"type":"message"}\n')

    const sessions = await piAdapter.discover(source)

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'pi-session-1',
      sourcePath: sessionFile,
      sourceKind: 'jsonl',
    })
    const parsed = await piAdapter.parse(sessions[0])
    expect(parsed).toMatchObject({
      messageCount: 2,
      toolCallCount: 1,
      metadata: { cwd: '/tmp/pi-project' },
    })
    const hints = await piAdapter.extractProjectHints(sessions[0])
    expect(hints).toContainEqual(
      expect.objectContaining({ kind: 'cwd', value: '/tmp/pi-project', agent: 'pi' }),
    )
  })
})

describe('OpenCode + Pi 默认 home 扫描', () => {
  let home: string

  beforeEach(async () => {
    home = makeTempHome()
    createOpenCodeDb(path.join(home, '.local', 'share', 'opencode'))
    writePiSession(
      path.join(home, '.pi', 'agent', 'sessions', 'project', 'session.jsonl'),
      'pi-default-home',
      '/tmp/pi-default',
    )
    await runInit({ nonInteractive: true, homeDir: home })
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('runScan 无 --source 时将两 agent 全部写入 DB', async () => {
    const summary = await runScan({ agents: ['opencode', 'pi'], homeDir: home })

    expect(summary).toMatchObject({ total: 3, new: 3, errors: 0 })
    const db = initDatabase(home)
    const rows = db
      .prepare('SELECT agent, COUNT(*) AS count FROM sessions GROUP BY agent ORDER BY agent')
      .all()
    db.close()
    expect(rows).toEqual([
      { agent: 'opencode', count: 2 },
      { agent: 'pi', count: 1 },
    ])
  })
})
