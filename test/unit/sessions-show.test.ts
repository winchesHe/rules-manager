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

    expect(readOpenCodeMessages).toHaveBeenCalledWith({
      sessionId: 'ses_test',
      directory: '/repo',
    })
    expect(output).toHaveBeenCalledWith(expect.stringContaining('private prompt'))
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

  it('拒绝读取不支持的 session', async () => {
    await runInit({ nonInteractive: true, homeDir: home })
    const { dbPath, workspaceDir } = resolveWorkspace(home)
    const workspace = new Database(dbPath)
    workspace
      .prepare(`
        INSERT INTO sessions
          (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
           status, first_seen_at, last_seen_at)
        VALUES (?, 'claude', '/tmp/source.jsonl', ?, 'default', 'hash', '2026-01-01',
                'new', '2026-01-01', '2026-01-01')
      `)
      .run('claude-session', path.join(workspaceDir, 'projects/default/claude-session.jsonl'))
    workspace.close()
    const readOpenCodeMessages = jest.fn(async () => [])

    await expect(
      runSessionsShow('claude-session', { homeDir: home }, { readOpenCodeMessages }),
    ).rejects.toThrow('仅支持 OpenCode/Codex')
    expect(readOpenCodeMessages).not.toHaveBeenCalled()
  })
})
