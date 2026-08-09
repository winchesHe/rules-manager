import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from '@jest/globals'
import { initDatabase } from '../../src/db'
import { resolveWorkspace } from '../../src/workspace'
import {
  querySessionContext,
  resolveSessionContextItems,
  resolveSessionDisplayNames,
} from '../../src/session-context'

const homes: string[] = []

describe('querySessionContext', () => {
  afterEach(() => {
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
  })

  it('按项目和闭区间日期过滤，并以 updatedAt/id 稳定倒序分页', () => {
    const home = seed([
      session('s-3', 'codex', 'alpha', '2026-07-10T10:00:00.000Z'),
      session('s-2', 'claude', 'alpha', '2026-07-10T10:00:00.000Z'),
      session('s-1', 'codex', 'default', '2026-07-01T00:00:00.000Z'),
      session('s-4', 'codex', 'alpha', '2026-08-01T00:00:00.001Z'),
    ])

    const first = querySessionContext({
      homeDir: home, project: 'alpha', from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z', limit: 1,
    })
    expect(first.items.map((item) => item.id)).toEqual(['s-3'])
    expect(first.nextCursor).not.toBeNull()
    const second = querySessionContext({
      homeDir: home, project: 'alpha', from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z', limit: 1, cursor: first.nextCursor ?? undefined,
    })
    expect(second.items.map((item) => item.id)).toEqual(['s-2'])
    expect(second.nextCursor).toBeNull()
  })

  it('all 包含 default 与 missing，且返回来源可用状态', () => {
    const home = seed([
      session('s-default', 'claude', 'default', '2026-07-01T00:00:00.000Z'),
      session('s-missing', 'codex', 'alpha', '2026-07-02T00:00:00.000Z', 'missing'),
    ])
    expect(querySessionContext({ homeDir: home, project: 'all', limit: 20 }).items)
      .toMatchObject([
        { id: 's-missing', slug: 'alpha', sourceAvailable: false },
        { id: 's-default', slug: 'default', sourceAvailable: true },
      ])
    expect(resolveSessionContextItems([
      { agent: 'claude', id: 's-default' },
      { agent: 'codex', id: 'not-in-db' },
    ], home)).toMatchObject([
      { id: 's-default', sourceAvailable: true },
      { id: 'not-in-db', status: 'missing', sourceAvailable: false },
    ])
  })

  it('在 SQL 分页前排除 Host 管理的 Session', () => {
    const home = seed([
      session('safe', 'codex', 'alpha', '2026-08-03T00:00:00.000Z'),
      session('internal', 'codex', 'alpha', '2026-08-02T00:00:00.000Z'),
      session('rules', 'claude', 'alpha', '2026-08-01T00:00:00.000Z'),
    ])

    const page = querySessionContext({
      homeDir: home,
      limit: 1,
      exclude: [
        { agent: 'codex', id: 'internal' },
        { agent: 'claude', id: 'rules' },
        ...Array.from({ length: 600 }, (_, index) => ({
          agent: 'codex', id: `historical-internal-${index}`,
        })),
      ],
    })

    expect(page.items.map((item) => item.id)).toEqual(['safe'])
    expect(page.nextCursor).toBeNull()
  })

  it('OpenCode 使用权威 SQLite title，其余来源返回稳定可读名称', () => {
    const home = seed([
      session('ses-readable', 'opencode', 'agent-workspace', '2026-07-02T00:00:00.000Z'),
      session('codex-readable', 'codex', 'rules-manager', '2026-07-01T00:00:00.000Z'),
    ])
    const sourcePath = path.join(home, 'opencode.db')
    const source = new Database(sourcePath)
    source.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)')
    source.prepare('INSERT INTO session (id, title) VALUES (?, ?)')
      .run('ses-readable', '修复 Chat Context 布局')
    source.close()
    const workspace = initDatabase(home)
    workspace.prepare('UPDATE sessions SET source_path = ? WHERE id = ?')
      .run(sourcePath, 'ses-readable')
    workspace.close()

    expect(querySessionContext({ homeDir: home, project: 'all', limit: 20 }).items)
      .toMatchObject([
        { id: 'ses-readable', displayName: '修复 Chat Context 布局' },
        { id: 'codex-readable', displayName: 'rules-manager · codex' },
      ])
  })

  it('按需读取 Claude、Codex、Copilot 与 JSONL Agent 的原生会话名称', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-session-names-'))
    homes.push(root)
    const claudePath = path.join(root, 'claude.jsonl')
    const cursorPath = path.join(root, 'cursor.jsonl')
    const copilotPath = path.join(root, 'workspace.yaml')
    fs.writeFileSync(claudePath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '原始问题' } }),
      JSON.stringify({ type: 'ai-title', aiTitle: '修复项目会话名称' }),
    ].join('\n'))
    fs.writeFileSync(cursorPath, JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '检查 Cursor 会话列表' }] },
    }))
    fs.writeFileSync(copilotPath, 'summary: 完善 Copilot Session 展示\n')

    const codexRoot = path.join(root, '.codex')
    const codexPath = path.join(codexRoot, 'sessions', '2026', '08', '02', 'rollout.jsonl')
    fs.mkdirSync(path.dirname(codexPath), { recursive: true })
    fs.writeFileSync(codexPath, '')
    const state = new Database(path.join(codexRoot, 'state_5.sqlite'))
    state.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        name TEXT,
        title TEXT,
        first_user_message TEXT
      )
    `)
    state.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)')
      .run('codex-readable', '', '重构 Chat View', '首条消息')
    state.close()

    const names = resolveSessionDisplayNames([
      { id: 'claude-readable', agent: 'claude', sourcePath: claudePath, slug: 'demo' },
      { id: 'codex-readable', agent: 'codex', sourcePath: codexPath, slug: 'demo' },
      { id: 'copilot-readable', agent: 'copilot', sourcePath: copilotPath, slug: 'demo' },
      { id: 'cursor-readable', agent: 'cursor', sourcePath: cursorPath, slug: 'demo' },
    ])

    expect(Object.fromEntries(names)).toEqual({
      'claude\0claude-readable': '修复项目会话名称',
      'codex\0codex-readable': '重构 Chat View',
      'copilot\0copilot-readable': '完善 Copilot Session 展示',
      'cursor\0cursor-readable': '检查 Cursor 会话列表',
    })
  })
})

function seed(rows: Array<Record<string, string>>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-context-query-'))
  homes.push(home)
  fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
  const db = initDatabase(home)
  const insert = db.prepare(`
    INSERT INTO sessions (
      id, agent, source_path, workspace_link, slug, content_hash, updated_at, status,
      first_seen_at, last_seen_at, classified_at, rules_status, rules_generated_at
    ) VALUES (
      @id, @agent, @source_path, @workspace_link, @slug, @content_hash, @updated_at,
      @status, @first_seen_at, @last_seen_at, NULL, NULL, NULL
    )
  `)
  for (const row of rows) insert.run(row)
  db.close()
  return home
}

function session(
  id: string,
  agent: string,
  slug: string,
  updatedAt: string,
  status = 'unchanged',
): Record<string, string> {
  return {
    id, agent, slug, status, updated_at: updatedAt,
    source_path: `/sessions/${id}.jsonl`, workspace_link: `/workspace/${slug}/${id}.jsonl`,
    content_hash: `hash-${id}`, first_seen_at: updatedAt, last_seen_at: updatedAt,
  }
}
