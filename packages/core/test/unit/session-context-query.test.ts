import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from '@jest/globals'
import { initDatabase } from '../../src/db'
import { resolveWorkspace } from '../../src/workspace'
import { querySessionContext, resolveSessionContextItems } from '../../src/session-context'

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
