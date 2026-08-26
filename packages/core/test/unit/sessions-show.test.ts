import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { jest } from '@jest/globals'
import { runInit } from '../../src/commands/init'
import { runSessionsShow } from '../../src/commands/sessions'
import { resolveWorkspace } from '../../src/workspace'

function fileHash(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

describe('sessions show', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-session-show-'))
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  it('按需读取 OpenCode 消息到 stdout，且不改工作区或源数据库', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const sourcePath = path.join(home, 'opencode.db')
    const source = new Database(sourcePath)
    source.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)')
    source.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('ses_test', '/repo')
    source.close()

    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES (?, 'opencode', ?, ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run('ses_test', sourcePath, path.join(workspaceDir, 'projects/default/ses_test.jsonl'))
    workspace.close()

    const workspaceHash = fileHash(dbPath)
    const sourceHash = fileHash(sourcePath)
    const readOpenCodeMessages = jest.fn(async () => [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'private prompt' }] },
    ])
    const output = jest.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSessionsShow('ses_test', { homeDir: home }, { readOpenCodeMessages })
    const streamChunks: string[] = []
    await runSessionsShow(
      'ses_test',
      { homeDir: home, stream: true },
      {
        readOpenCodeMessages,
        writeOutput: async (chunk: string) => streamChunks.push(chunk) > 0,
      },
    )

    expect(readOpenCodeMessages).toHaveBeenCalledTimes(2)
    expect(readOpenCodeMessages).toHaveBeenLastCalledWith({
      sessionId: 'ses_test',
      directory: '/repo',
    })
    expect(output).toHaveBeenCalledWith(expect.stringContaining('private prompt'))
    expect(JSON.parse(streamChunks[0])).toMatchObject({
      sessionId: 'ses_test',
      agent: 'opencode',
      index: 0,
      record: { info: { role: 'user' } },
    })
    expect(fileHash(dbPath)).toBe(workspaceHash)
    expect(fileHash(sourcePath)).toBe(sourceHash)
    expect(fs.readdirSync(workspaceDir).filter((name) => name.includes('ses_test'))).toEqual([])
  })

  it('按需读取 Codex JSONL 到 stdout，且不改工作区或源文件', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const sourcePath = path.join(home, 'rollout-codex-test.jsonl')
    fs.writeFileSync(
      sourcePath,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'codex-test', cwd: '/repo' } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: 'private codex prompt' },
        }),
      ].join('\n') + '\n',
    )

    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES (?, 'codex', ?, ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run('codex-test', sourcePath, path.join(workspaceDir, 'projects/default/codex-test.jsonl'))
    workspace.close()

    const workspaceHash = fileHash(dbPath)
    const sourceHash = fileHash(sourcePath)
    const output = jest.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSessionsShow('codex-test', { homeDir: home })

    expect(output).toHaveBeenCalledWith(expect.stringContaining('private codex prompt'))
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"agent": "codex"'))
    expect(fileHash(dbPath)).toBe(workspaceHash)
    expect(fileHash(sourcePath)).toBe(sourceHash)
  })

  it('以 NDJSON 顺序流式输出 JSONL records', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const sourcePath = path.join(home, 'stream-codex.jsonl')
    fs.writeFileSync(
      sourcePath,
      '\uFEFF' + [
        JSON.stringify({ type: 'first', text: 'one' }),
        JSON.stringify({ type: 'second', text: 'two' }),
      ].join('\r\n') + '\r\n',
    )
    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES ('stream-codex', 'codex', ?, ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run(sourcePath, path.join(workspaceDir, 'projects/default/stream-codex.jsonl'))
    workspace.close()
    const chunks: string[] = []

    await runSessionsShow(
      'stream-codex',
      { homeDir: home, stream: true },
      { writeOutput: async (chunk: string) => chunks.push(chunk) > 0 },
    )

    expect(chunks).toHaveLength(2)
    expect(chunks.every((chunk) => chunk.endsWith('\n'))).toBe(true)
    expect(chunks.map((chunk) => JSON.parse(chunk))).toEqual([
      {
        sessionId: 'stream-codex',
        agent: 'codex',
        index: 0,
        record: { type: 'first', text: 'one' },
      },
      {
        sessionId: 'stream-codex',
        agent: 'codex',
        index: 1,
        record: { type: 'second', text: 'two' },
      },
    ])
  })

  it('流式模式允许超过 50 MiB 的 JSONL，并可由下游提前停止', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const sourcePath = path.join(home, 'large-codex.jsonl')
    fs.writeFileSync(sourcePath, `${JSON.stringify({ type: 'first', text: 'available' })}\n`)
    fs.truncateSync(sourcePath, 50 * 1024 * 1024 + 1)
    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES ('large-codex', 'codex', ?, ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run(sourcePath, path.join(workspaceDir, 'projects/default/large-codex.jsonl'))
    workspace.close()
    const chunks: string[] = []

    await runSessionsShow(
      'large-codex',
      { homeDir: home, stream: true },
      {
        writeOutput: async (chunk: string) => {
          chunks.push(chunk)
          return false
        },
      },
    )

    expect(chunks).toHaveLength(1)
    expect(JSON.parse(chunks[0])).toMatchObject({
      sessionId: 'large-codex',
      index: 0,
      record: { text: 'available' },
    })
    await expect(runSessionsShow('large-codex', { homeDir: home })).rejects.toThrow(
      '超过 50 MiB',
    )
  })

  it('流式 JSONL 保留非法记录的文件与行号诊断', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const sourcePath = path.join(home, 'invalid-stream.jsonl')
    fs.writeFileSync(sourcePath, '{"type":"message"}\nnot-json\n')
    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES ('invalid-stream', 'pi', ?, ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run(sourcePath, path.join(workspaceDir, 'projects/default/invalid-stream.jsonl'))
    workspace.close()

    await expect(
      runSessionsShow(
        'invalid-stream',
        { homeDir: home, stream: true },
        { writeOutput: async () => true },
      ),
    ).rejects.toThrow(`${sourcePath}:2`)
  })

  it('流式输出遇到 EPIPE 时正常结束', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const sourcePath = path.join(home, 'epipe.jsonl')
    fs.writeFileSync(sourcePath, `${JSON.stringify({ type: 'message' })}\n`)
    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES ('epipe', 'cursor', ?, ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run(sourcePath, path.join(workspaceDir, 'projects/default/epipe.jsonl'))
    workspace.close()
    const brokenPipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })

    await expect(
      runSessionsShow(
        'epipe',
        { homeDir: home, stream: true },
        { writeOutput: async () => { throw brokenPipe } },
      ),
    ).resolves.toBeUndefined()
  })

  it.each([
    ['cursor', false],
    ['pi', false],
    ['claude', true],
  ] as const)('按需读取 %s 完整 JSONL records', async (agent, usesDirectory) => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const sessionId = `${agent}-test`
    const sourcePath = usesDirectory ? path.join(home, sessionId) : path.join(home, `${sessionId}.jsonl`)
    const files = usesDirectory
      ? [path.join(sourcePath, 'main.jsonl'), path.join(sourcePath, 'subagents/agent.jsonl')]
      : [sourcePath]
    for (const [index, filePath] of files.entries()) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, `${JSON.stringify({ type: 'message', text: `${agent}-${index}` })}\n`)
    }

    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run(sessionId, agent, sourcePath, path.join(workspaceDir, `projects/default/${sessionId}.jsonl`))
    workspace.close()

    const sourceHashes = files.map(fileHash)
    const output = jest.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSessionsShow(sessionId, { homeDir: home })

    expect(output).toHaveBeenCalledWith(expect.stringContaining(`${agent}-0`))
    if (usesDirectory) expect(output).toHaveBeenCalledWith(expect.stringContaining(`${agent}-1`))
    expect(files.map(fileHash)).toEqual(sourceHashes)
  })

  it('按需读取 Copilot events.jsonl', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const sourcePath = path.join(home, 'copilot/session-state/copilot-events/events.jsonl')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, `${JSON.stringify({ type: 'user.message', text: 'copilot event' })}\n`)
    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES ('copilot-events', 'copilot', ?, ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run(sourcePath, path.join(workspaceDir, 'projects/default/copilot-events.jsonl'))
    workspace.close()
    const sourceHash = fileHash(sourcePath)
    const output = jest.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSessionsShow('copilot-events', { homeDir: home })
    const streamChunks: string[] = []
    await runSessionsShow(
      'copilot-events',
      { homeDir: home, stream: true },
      { writeOutput: async (chunk: string) => streamChunks.push(chunk) > 0 },
    )

    expect(output).toHaveBeenCalledWith(expect.stringContaining('copilot event'))
    expect(JSON.parse(streamChunks[0])).toMatchObject({
      agent: 'copilot',
      index: 0,
      record: { text: 'copilot event' },
    })
    expect(fileHash(sourcePath)).toBe(sourceHash)
  })

  it('Copilot metadata-only session 回退读取 session-store.db turns', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const copilotRoot = path.join(home, 'copilot')
    const sourcePath = path.join(copilotRoot, 'session-state/copilot-turns/workspace.yaml')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, 'id: copilot-turns\n')
    const storePath = path.join(copilotRoot, 'session-store.db')
    const store = new Database(storePath)
    store.exec(`
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        user_message TEXT,
        assistant_response TEXT,
        timestamp TEXT
      )
    `)
    store
      .prepare('INSERT INTO turns (session_id, turn_index, user_message, assistant_response) VALUES (?, 0, ?, ?)')
      .run('copilot-turns', 'copilot private prompt', 'copilot private response')
    store.close()
    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES ('copilot-turns', 'copilot', ?, ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run(sourcePath, path.join(workspaceDir, 'projects/default/copilot-turns.jsonl'))
    workspace.close()
    const sourceHash = fileHash(sourcePath)
    const storeHash = fileHash(storePath)
    const output = jest.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSessionsShow('copilot-turns', { homeDir: home })
    const streamChunks: string[] = []
    await runSessionsShow(
      'copilot-turns',
      { homeDir: home, stream: true },
      { writeOutput: async (chunk: string) => streamChunks.push(chunk) > 0 },
    )

    expect(output).toHaveBeenCalledWith(expect.stringContaining('copilot private prompt'))
    expect(output).toHaveBeenCalledWith(expect.stringContaining('copilot private response'))
    expect(JSON.parse(streamChunks[0])).toMatchObject({
      agent: 'copilot',
      index: 0,
      record: {
        turn_index: 0,
        user_message: 'copilot private prompt',
        assistant_response: 'copilot private response',
      },
    })
    expect(fileHash(sourcePath)).toBe(sourceHash)
    expect(fileHash(storePath)).toBe(storeHash)
  })

  it('Copilot metadata-only 且 turns 为空时明确报源端未持久化对话', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const copilotRoot = path.join(home, 'copilot')
    const sourcePath = path.join(copilotRoot, 'session-state/copilot-empty/workspace.yaml')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, 'id: copilot-empty\n')
    const store = new Database(path.join(copilotRoot, 'session-store.db'))
    store.exec('CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT)')
    store.close()
    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES ('copilot-empty', 'copilot', ?, ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run(sourcePath, path.join(workspaceDir, 'projects/default/copilot-empty.jsonl'))
    workspace.close()

    await expect(runSessionsShow('copilot-empty', { homeDir: home })).rejects.toThrow(
      '源端未持久化对话',
    )
  })

  it('JSONL 存在非法行时明确报文件和行号，不静默返回部分内容', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const sourcePath = path.join(home, 'invalid.jsonl')
    fs.writeFileSync(sourcePath, '{"type":"message"}\nnot-json\n')
    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES ('invalid-jsonl', 'pi', ?, ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run(sourcePath, path.join(workspaceDir, 'projects/default/invalid-jsonl.jsonl'))
    workspace.close()

    await expect(runSessionsShow('invalid-jsonl', { homeDir: home })).rejects.toThrow(
      `${sourcePath}:2`,
    )
  })

  it('兼容 UTF-8 BOM 和 CRLF JSONL', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const sourcePath = path.join(home, 'bom-crlf.jsonl')
    fs.writeFileSync(sourcePath, '\uFEFF{"text":"first"}\r\n{"text":"second"}\r\n')
    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES ('bom-crlf', 'cursor', ?, ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run(sourcePath, path.join(workspaceDir, 'projects/default/bom-crlf.jsonl'))
    workspace.close()
    const output = jest.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSessionsShow('bom-crlf', { homeDir: home })

    expect(output).toHaveBeenCalledWith(expect.stringContaining('first'))
    expect(output).toHaveBeenCalledWith(expect.stringContaining('second'))
  })

  it('拒绝读取不支持的 session', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES (?, 'unknown', '/tmp/source.jsonl', ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run('claude-session', path.join(workspaceDir, 'projects/default/claude-session.jsonl'))
    workspace.close()
    const readOpenCodeMessages = jest.fn(async () => [])

    await expect(
      runSessionsShow('claude-session', { homeDir: home }, { readOpenCodeMessages }),
    ).rejects.toThrow('不支持的 agent')
    expect(readOpenCodeMessages).not.toHaveBeenCalled()
  })
})
