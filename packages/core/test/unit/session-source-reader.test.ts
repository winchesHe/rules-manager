import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import {
  readSessionSources,
  type SessionSourceReadResult,
} from '../../src/session-source-reader'
import { resolveWorkspace } from '../../src/workspace'
import type { AgentName, SessionStatus } from '../../src/types'

interface SessionReference {
  agent: AgentName
  id: string
}

describe('session source reader', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-source-reader-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function addSession(
    id: string,
    agent: AgentName,
    sourcePath: string,
    status: SessionStatus = 'updated',
  ): void {
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'demo', 'hash', '2026-08-09', ?, '2026-08-09', '2026-08-09')
    `).run(id, agent, sourcePath, `/tmp/${id}.jsonl`, status)
    db.close()
  }

  function writeJsonl(id: string, agent: AgentName): string {
    const sourcePath = path.join(home, `${id}.jsonl`)
    fs.writeFileSync(sourcePath, `${JSON.stringify({
      role: 'user',
      content: `${agent} prompt`,
      timestamp: '2026-08-09T00:00:00Z',
    })}\n`)
    return sourcePath
  }

  function expectReadable(
    result: SessionSourceReadResult,
    agent: AgentName,
    text: string,
  ): void {
    expect(result).toMatchObject({
      agent,
      status: 'readable',
      messageCount: expect.any(Number),
    })
    expect(result.messages.some((message) => message.content === text)).toBe(true)
  }

  it('按 selection 顺序为既有 Agent 返回唯一 readable 终态', async () => {
    const references: SessionReference[] = (['claude', 'codex', 'cursor', 'pi'] as const).map((agent) => {
      const id = `${agent}-session`
      addSession(id, agent, writeJsonl(id, agent))
      return { agent, id }
    })

    const copilotId = 'copilot-session'
    const copilotPath = path.join(home, 'copilot', 'session-state', copilotId, 'events.jsonl')
    fs.mkdirSync(path.dirname(copilotPath), { recursive: true })
    fs.writeFileSync(copilotPath, `${JSON.stringify({ type: 'user.message', text: 'copilot prompt' })}\n`)
    addSession(copilotId, 'copilot', copilotPath)
    references.push({ agent: 'copilot', id: copilotId })

    const openCodeId = 'opencode-session'
    const openCodePath = path.join(home, 'opencode.db')
    const sourceDb = new Database(openCodePath)
    sourceDb.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `)
    sourceDb.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
      'message-1', openCodeId, 1, JSON.stringify({ role: 'user', time: { created: 1 } }),
    )
    sourceDb.prepare('INSERT INTO part VALUES (?, ?, ?)').run(
      'part-1', 'message-1', JSON.stringify({ text: 'opencode prompt' }),
    )
    sourceDb.close()
    addSession(openCodeId, 'opencode', openCodePath)
    references.push({ agent: 'opencode', id: openCodeId })

    const results = await readSessionSources(references, { homeDir: home })

    expect(results.map(({ agent, sessionId, status }) => ({ agent, sessionId, status }))).toEqual(
      references.map(({ agent, id }) => ({ agent, sessionId: id, status: 'readable' })),
    )
    expect(results.map((result) => result.sourceRevision?.kind)).toEqual([
      'jsonl-watermark',
      'jsonl-watermark',
      'jsonl-watermark',
      'jsonl-watermark',
      'jsonl-watermark',
      'sqlite-transaction',
    ])
    expect(results.every((result) => result.sourceRevision?.changedDuringRun === false)).toBe(true)
    for (const { agent, id } of references) {
      expectReadable(
        results.find((result) => result.sessionId === id)!,
        agent,
        `${agent} prompt`,
      )
    }
  })

  it('区分索引缺失、Agent 不匹配、missing 状态和源缺失', async () => {
    const existingPath = writeJsonl('indexed', 'codex')
    addSession('indexed', 'codex', existingPath)
    addSession('marked-missing', 'pi', path.join(home, 'missing-pi.jsonl'), 'missing')
    addSession('source-missing', 'cursor', path.join(home, 'missing-cursor.jsonl'))

    const results = await readSessionSources([
      { agent: 'claude', id: 'not-indexed' },
      { agent: 'claude', id: 'indexed' },
      { agent: 'pi', id: 'marked-missing' },
      { agent: 'cursor', id: 'source-missing' },
    ], { homeDir: home })

    expect(results.map(({ status, errorCode }) => ({ status, errorCode }))).toEqual([
      { status: 'unavailable', errorCode: 'SESSION_NOT_INDEXED' },
      { status: 'unavailable', errorCode: 'SESSION_AGENT_MISMATCH' },
      { status: 'unavailable', errorCode: 'SESSION_INDEX_UNAVAILABLE' },
      { status: 'unavailable', errorCode: 'SOURCE_NOT_FOUND' },
    ])
    expect(results.every((result) => result.messageCount === 0)).toBe(true)
  })

  it('把无可用消息记为 empty，并保留稳定错误码', async () => {
    const sourcePath = path.join(home, 'empty.jsonl')
    fs.writeFileSync(sourcePath, `${JSON.stringify({ type: 'session_meta', payload: { id: 'empty' } })}\n`)
    addSession('empty', 'codex', sourcePath)

    await expect(readSessionSources([{ agent: 'codex', id: 'empty' }], { homeDir: home }))
      .resolves.toMatchObject([{
        status: 'empty',
        messageCount: 0,
        messages: [],
        errorCode: 'SOURCE_EMPTY',
      }])
  })

  it('Copilot metadata-only 回退读取 session-store turns', async () => {
    const copilotRoot = path.join(home, 'copilot')
    const sourcePath = path.join(copilotRoot, 'session-state', 'copilot-turns', 'workspace.yaml')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, 'id: copilot-turns\n')
    const store = new Database(path.join(copilotRoot, 'session-store.db'))
    store.exec(`
      CREATE TABLE turns (
        session_id TEXT,
        turn_index INTEGER,
        user_message TEXT,
        assistant_response TEXT,
        timestamp TEXT
      )
    `)
    store.prepare('INSERT INTO turns VALUES (?, 0, ?, ?, ?)').run(
      'copilot-turns',
      'copilot prompt',
      'copilot response',
      '2026-08-09T00:00:00Z',
    )
    store.close()
    addSession('copilot-turns', 'copilot', sourcePath)

    const [result] = await readSessionSources(
      [{ agent: 'copilot', id: 'copilot-turns' }],
      { homeDir: home },
    )

    expect(result).toMatchObject({
      status: 'readable',
      messageCount: 2,
      messages: [
        { role: 'user', content: 'copilot prompt' },
        { role: 'assistant', content: 'copilot response' },
      ],
    })
  })

  it('把 JSONL 格式错误和 SQLite 查询错误记为 failed，而不是抛出或丢失', async () => {
    const invalidJsonl = path.join(home, 'invalid.jsonl')
    fs.writeFileSync(invalidJsonl, 'not-json\n')
    addSession('invalid-jsonl', 'claude', invalidJsonl)

    const invalidSqlite = path.join(home, 'invalid.db')
    new Database(invalidSqlite).close()
    addSession('invalid-sqlite', 'opencode', invalidSqlite)

    const results = await readSessionSources([
      { agent: 'claude', id: 'invalid-jsonl' },
      { agent: 'opencode', id: 'invalid-sqlite' },
    ], { homeDir: home })

    expect(results.map(({ status, errorCode }) => ({ status, errorCode }))).toEqual([
      { status: 'failed', errorCode: 'SOURCE_FORMAT_INVALID' },
      { status: 'failed', errorCode: 'SOURCE_READ_FAILED' },
    ])
    expect(results.map((result) => result.sourceRevision?.kind)).toEqual([
      'jsonl-watermark',
      'sqlite-transaction',
    ])
  })

  it('JSONL 固定开始时的文件集合与字节边界，并记录运行中变化', async () => {
    const sessionId = 'changing-jsonl'
    const sourcePath = path.join(home, sessionId)
    const initialPath = path.join(sourcePath, 'initial.jsonl')
    fs.mkdirSync(sourcePath, { recursive: true })
    fs.writeFileSync(initialPath, `${JSON.stringify({ role: 'user', content: 'initial' })}\n`)
    addSession(sessionId, 'claude', sourcePath)

    const [result] = await readSessionSources(
      [{ agent: 'claude', id: sessionId }],
      { homeDir: home },
      {
        afterJsonlSnapshot: () => {
          fs.appendFileSync(initialPath, `${JSON.stringify({ role: 'user', content: 'appended' })}\n`)
          fs.writeFileSync(
            path.join(sourcePath, 'new.jsonl'),
            `${JSON.stringify({ role: 'user', content: 'new file' })}\n`,
          )
        },
      },
    )

    expect(result.messages.map((message) => message.content)).toEqual(['initial'])
    expect(result.sourceRevision).toMatchObject({
      kind: 'jsonl-watermark',
      changedDuringRun: true,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it('OpenCode 同路径 Session 在一个短事务快照中批量读取并披露并发写入', async () => {
    const sourcePath = path.join(home, 'changing-opencode.db')
    const source = new Database(sourcePath)
    source.pragma('journal_mode = WAL')
    source.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `)
    const insertMessage = source.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
    const insertPart = source.prepare('INSERT INTO part VALUES (?, ?, ?)')
    for (const id of ['open-1', 'open-2']) {
      insertMessage.run(`${id}-initial`, id, 1, JSON.stringify({ role: 'user' }))
      insertPart.run(`${id}-part-initial`, `${id}-initial`, JSON.stringify({ text: `${id} initial` }))
      addSession(id, 'opencode', sourcePath)
    }
    source.close()
    let transactionCount = 0

    const results = await readSessionSources(
      [
        { agent: 'opencode', id: 'open-1' },
        { agent: 'opencode', id: 'open-2' },
      ],
      { homeDir: home },
      {
        afterSqliteSnapshot: () => {
          transactionCount++
          const writer = new Database(sourcePath)
          writer.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
            'open-1-appended', 'open-1', 2, JSON.stringify({ role: 'user' }),
          )
          writer.prepare('INSERT INTO part VALUES (?, ?, ?)').run(
            'open-1-part-appended', 'open-1-appended', JSON.stringify({ text: 'appended' }),
          )
          writer.close()
        },
      },
    )

    expect(transactionCount).toBe(1)
    expect(results.map((result) => result.messages.map((message) => message.content))).toEqual([
      ['open-1 initial'],
      ['open-2 initial'],
    ])
    expect(results.every((result) => result.sourceRevision?.kind === 'sqlite-transaction')).toBe(true)
    expect(results.every((result) => result.sourceRevision?.changedDuringRun)).toBe(true)
    const verify = new Database(sourcePath, { readonly: true })
    expect(verify.prepare(
      "SELECT COUNT(*) AS count FROM message WHERE id = 'open-1-appended'",
    ).pluck().get()).toBe(1)
    verify.close()
  })
})
