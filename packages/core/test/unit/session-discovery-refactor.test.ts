import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeAdapter } from '../../src/adapters/claude'
import { codexAdapter } from '../../src/adapters/codex'
import { copilotAdapter } from '../../src/adapters/copilot'
import { cursorAdapter } from '../../src/adapters/cursor'
import { runInit } from '../../src/commands/init'
import { initDatabase } from '../../src/db'
import { runScan } from '../../src/scanner'
import { recordInternalSessionExclusion } from '../../src/session-exclusions'
import { resolveWorkspace } from '../../src/workspace'

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-session-discovery-'))
}

function writeJsonl(filePath: string, rows: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

describe('agent session 获取逻辑重构', () => {
  let home: string

  beforeEach(() => {
    home = makeTempHome()
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('未传 --source 时自动扫描 <home>/.claude', async () => {
    const sessionId = 'native-claude-session'
    writeJsonl(path.join(home, '.claude', 'projects', '-tmp-project', `${sessionId}.jsonl`), [
      {
        type: 'user',
        sessionId,
        cwd: '/tmp/project',
        timestamp: '2026-07-24T01:00:00.000Z',
        message: { content: 'test' },
      },
    ])
    await runInit({ nonInteractive: true, homeDir: home })

    const summary = await runScan({ agents: ['claude'], homeDir: home })

    expect(summary).toMatchObject({ total: 1, new: 1, errors: 0 })
    const db = initDatabase(home)
    const row = db.prepare('SELECT id, agent FROM sessions').get() as {
      id: string
      agent: string
    }
    db.close()
    expect(row).toEqual({ id: sessionId, agent: 'claude' })
  })

  it('二次扫描时不把已登记的内部 Evidence Provider Session 写入索引', async () => {
    const sessionId = '019f8882-a360-7033-9b02-08100c51ca97'
    writeJsonl(path.join(
      home, '.codex', 'sessions', '2026', '08', '09', `rollout-${sessionId}.jsonl`,
    ), [{
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/tmp/project' },
    }, {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: '[memory-manager:live-evidence-map]' },
    }])
    await runInit({ nonInteractive: true, homeDir: home })
    recordInternalSessionExclusion(
      resolveWorkspace(home).chatsDir,
      { agent: 'codex', id: sessionId },
      '2026-08-09T00:00:00.000Z',
    )

    const summary = await runScan({ agents: ['codex'], homeDir: home })

    expect(summary).toMatchObject({ total: 0, new: 0, errors: 0 })
    const db = initDatabase(home)
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 })
    db.close()
  })

  it('Claude 扫描项目目录下非 UUID 命名的顶层 JSONL', async () => {
    const source = path.join(home, '.claude')
    const sessionFile = path.join(source, 'projects', '-tmp-project', 'named-session.jsonl')
    writeJsonl(sessionFile, [
      {
        type: 'user',
        sessionId: 'provider-session-id',
        cwd: '/tmp/project',
        timestamp: '2026-07-24T01:00:00.000Z',
        message: { content: 'test' },
      },
    ])

    const sessions = await claudeAdapter.discover(source)

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'provider-session-id',
      sourcePath: sessionFile,
    })
  })

  it('Claude 同一 provider sessionId 的重复文件只返回一条 session', async () => {
    const source = path.join(home, '.claude')
    const projectDir = path.join(source, 'projects', '-tmp-project')
    const row = {
      type: 'user',
      sessionId: 'duplicate-provider-session',
      cwd: '/tmp/project',
      message: { content: 'test' },
    }
    writeJsonl(path.join(projectDir, 'copy-a.jsonl'), [row])
    writeJsonl(path.join(projectDir, 'copy-b.jsonl'), [row])

    const sessions = await claudeAdapter.discover(source)

    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe('duplicate-provider-session')
  })

  it('Claude 多文件 session 的 updatedAt 取最后一次文件活动时间', async () => {
    const source = path.join(home, '.claude')
    const sessionId = '019f8882-a360-7033-9b02-08100c51ca96'
    const sessionDir = path.join(source, 'projects', '-tmp-project', sessionId)
    const firstFile = path.join(sessionDir, 'first.jsonl')
    const latestFile = path.join(sessionDir, 'latest.jsonl')
    writeJsonl(firstFile, [{ type: 'user', message: { content: 'first' } }])
    writeJsonl(latestFile, [{ type: 'assistant', message: { content: 'latest' } }])
    const firstActivity = new Date('2026-07-20T00:00:00.000Z')
    const latestActivity = new Date('2026-07-29T12:34:56.000Z')
    fs.utimesSync(firstFile, firstActivity, firstActivity)
    fs.utimesSync(latestFile, latestActivity, latestActivity)

    const [session] = await claudeAdapter.discover(source)

    expect(session.updatedAt).toBe(latestActivity.toISOString())
  })

  it('Codex 同时递归扫描 active 与 archived rollout', async () => {
    const source = path.join(home, '.codex')
    const activeId = '019f8882-a360-7033-9b02-08100c51ca96'
    const archivedId = '019f8772-f579-7753-abce-53f1f517eaa3'
    const row = (id: string) => ({
      type: 'session_meta',
      timestamp: '2026-07-24T01:00:00.000Z',
      payload: { id, cwd: '/tmp/project', timestamp: '2026-07-24T01:00:00.000Z' },
    })
    writeJsonl(
      path.join(source, 'sessions', '2026', '07', '24', '10', `rollout-${activeId}.jsonl`),
      [row(activeId)],
    )
    writeJsonl(path.join(source, 'archived_sessions', `rollout-${archivedId}.jsonl`), [
      row(archivedId),
    ])

    const sessions = await codexAdapter.discover(source)

    expect(sessions.map((session) => session.id).sort()).toEqual(
      [activeId, archivedId].sort(),
    )
  })

  it('Copilot 将仅有 workspace.yaml 的 session 纳入扫描与分类', async () => {
    const source = path.join(home, '.copilot')
    const sessionId = 'a144f126-876d-4438-b163-a3ea3806d455'
    const metadataFile = path.join(source, 'session-state', sessionId, 'workspace.yaml')
    fs.mkdirSync(path.dirname(metadataFile), { recursive: true })
    fs.writeFileSync(
      metadataFile,
      [
        `id: ${sessionId}`,
        'cwd: /tmp/copilot-project',
        'git_root: /tmp/copilot-project',
        'branch: main',
        'created_at: 2026-07-23T01:00:00.000Z',
        'updated_at: 2026-07-24T01:00:00.000Z',
      ].join('\n') + '\n',
    )

    const sessions = await copilotAdapter.discover(source)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      sourcePath: metadataFile,
      sourceKind: 'yaml',
      updatedAt: '2026-07-24T01:00:00.000Z',
    })

    const parsed = await copilotAdapter.parse(sessions[0])
    expect(parsed.metadata).toMatchObject({
      cwd: '/tmp/copilot-project',
      gitRoot: '/tmp/copilot-project',
      branch: 'main',
    })
    const hints = await copilotAdapter.extractProjectHints(sessions[0])
    expect(hints.some((hint) => hint.kind === 'git_root')).toBe(true)
  })

  it('Cursor 扫描每个 transcript 目录的顶层 JSONL，不依赖 UUID 或同名文件', async () => {
    const source = path.join(home, '.cursor')
    const sessionFile = path.join(
      source,
      'projects',
      'tmp-cursor-project',
      'agent-transcripts',
      'named-session',
      'transcript.jsonl',
    )
    writeJsonl(sessionFile, [{ role: 'user', message: { content: [{ type: 'text' }] } }])

    const sessions = await cursorAdapter.discover(source)

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: 'named-session', sourcePath: sessionFile })
  })
})
