import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from '@jest/globals'
import { initDatabase } from '../../core/src/db'
import { resolveWorkspace } from '../../core/src/workspace'
import { resolveProjectLocation, resolveSessionLocation } from '../main/source-location'

const homes: string[] = []

describe('source location', () => {
  afterEach(() => {
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
  })

  it('只返回真实存在的项目目录并拒绝目录穿越', () => {
    const home = makeHome()
    const projectPath = path.join(resolveWorkspace(home).projectsDir, 'demo')
    fs.mkdirSync(projectPath, { recursive: true })

    expect(resolveProjectLocation('demo', home)).toBe(projectPath)
    expect(() => resolveProjectLocation('../outside', home)).toThrow('project slug is invalid')
    expect(() => resolveProjectLocation('missing', home)).toThrow('project location is unavailable')
  })

  it('从索引解析存在的 Session 原始来源并明确处理失效来源', () => {
    const home = makeHome()
    const sourcePath = path.join(home, 'session.jsonl')
    fs.writeFileSync(sourcePath, '{}\n')
    const db = initDatabase(home)
    const workspace = resolveWorkspace(home)
    db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at, status,
        first_seen_at, last_seen_at
      ) VALUES (?, 'codex', ?, ?, 'demo', 'hash', ?, 'unchanged', ?, ?)
    `).run(
      'session-1',
      sourcePath,
      path.join(workspace.projectsDir, 'demo/session-1.jsonl'),
      '2026-08-02T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
    )
    db.close()

    expect(resolveSessionLocation('session-1', home)).toBe(sourcePath)
    fs.unlinkSync(sourcePath)
    expect(() => resolveSessionLocation('session-1', home)).toThrow('session source is unavailable')
    expect(() => resolveSessionLocation('missing', home)).toThrow('session was not found')
  })
})

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-source-location-'))
  homes.push(home)
  fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
  return home
}
