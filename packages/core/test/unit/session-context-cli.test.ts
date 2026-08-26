import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tsxCli = path.resolve(projectRoot, '../../node_modules/tsx/dist/cli.mjs')

function runCli(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, 'src/cli.ts', ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
  })
}

describe('context CLI', () => {
  let tempDir: string
  let workspaceParent: string
  let dbPath: string
  let sourcePath: string
  let contextRunIds: string[]

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-context-cli-'))
    workspaceParent = path.join(tempDir, 'workspace')
    contextRunIds = []
    expect(runCli(['init', '--non-interactive', '--workspace', workspaceParent]).status).toBe(0)
    dbPath = path.join(workspaceParent, '.memory-manager', 'memory.db')
  })

  afterEach(() => {
    for (const runId of contextRunIds) {
      runCli(['context', 'close', runId, '--workspace', workspaceParent])
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function addCodexSession(): void {
    sourcePath = path.join(tempDir, 'codex-session.jsonl')
    fs.writeFileSync(sourcePath, [
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '检查 Chrome 页面' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'mcp__chrome__navigate',
          arguments: { url: 'https://example.com' },
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'done' },
      },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')
    const db = new Database(dbPath)
    db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES ('cli-context', 'codex', ?, ?, 'demo', 'hash',
                '2026-08-09T00:00:00.000Z', 'updated', '2026-08-09', '2026-08-09')
    `).run(sourcePath, path.join(workspaceParent, 'cli-context.jsonl'))
    db.close()
  }

  it('prepare 只建轻量清单，read/locate 实时读取 prepare 后的最新源', () => {
    addCodexSession()
    const query = JSON.stringify({
      version: 2,
      where: { usedTool: { families: ['chrome-use'] } },
    })
    const prepare = runCli([
      'context',
      'prepare',
      '--query-json',
      query,
      '--workspace',
      workspaceParent,
    ])

    expect(prepare.status).toBe(0)
    expect(prepare.stderr).toBe('')
    const prepared = JSON.parse(prepare.stdout) as {
      runId: string
      coverage: { candidates: number; matched: number; unknown: number }
      sessionCount: number
      sessionsCommand: string
      closeCommand: string
    }
    expect(prepared.coverage).toEqual({
      candidates: 1,
      inspected: 1,
      matched: 1,
      notMatched: 0,
      unknown: 0,
      unknownSource: 0,
      unknownOrigin: 0,
      unknownToolParse: 0,
      changedDuringRun: 0,
    })
    contextRunIds.push(prepared.runId)
    expect(prepared.sessionCount).toBe(1)
    expect(prepared).toMatchObject({ contentMode: 'live-source', contentStored: false })
    expect(prepared).not.toHaveProperty('sessions')
    expect(prepared.sessionsCommand).toContain(prepared.runId)
    const runDir = path.join(
      os.tmpdir(),
      'memory-manager-context-runs',
      `memory-manager-context-${prepared.runId}`,
    )
    expect(fs.readdirSync(runDir).sort()).toEqual(['manifest.json', 'owner.json'])
    const sessionsResult = runCli([
      'context', 'sessions', prepared.runId, '--limit', '1', '--workspace', workspaceParent,
    ])
    expect(sessionsResult.status).toBe(0)
    const sessions = JSON.parse(sessionsResult.stdout) as {
      total: number
      items: Array<{
        id: string
        eventCountAtPrepare: number
        proofCount: number
        toolFamilies: string[]
      }>
    }
    expect(sessions.total).toBe(1)
    expect(sessions.items).toEqual([
      expect.objectContaining({
        id: 'cli-context',
        eventCountAtPrepare: 3,
        proofCount: 1,
        toolFamilies: ['chrome-use'],
        contentMode: 'live-source',
      }),
    ])
    expect(prepared.closeCommand).toContain(prepared.runId)

    const status = runCli([
      'context', 'status', prepared.runId, '--workspace', workspaceParent,
    ])
    expect(status.status).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({
      runId: prepared.runId,
      coverage: { matched: 1, unknown: 0 },
      contentMode: 'live-source',
      contentStored: false,
    })

    fs.appendFileSync(sourcePath, `${JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: 'prepare 之后新增' },
    })}\n`)

    const read = runCli([
      'context',
      'read',
      prepared.runId,
      '--session',
      'cli-context',
      '--part',
      '1',
      '--workspace',
      workspaceParent,
    ])
    expect(read.status).toBe(0)
    expect(JSON.parse(read.stdout)).toMatchObject({
      runId: prepared.runId,
      sessionId: 'cli-context',
      part: 1,
      partCount: 1,
      contentMode: 'live-source',
      selectionStatus: 'matched',
      selectionChanged: false,
      sourceChangedSincePrepare: true,
      events: [
        expect.objectContaining({ kind: 'message', role: 'user', origin: 'human_user' }),
        expect.objectContaining({ kind: 'tool_call', toolName: 'mcp__chrome__navigate' }),
        expect.objectContaining({ kind: 'tool_result', toolCallId: 'call-1' }),
        expect.objectContaining({ content: 'prepare 之后新增' }),
      ],
    })

    const proofs = runCli([
      'context', 'proofs', prepared.runId, '--session', 'cli-context',
      '--workspace', workspaceParent,
    ])
    expect(proofs.status).toBe(0)
    expect(JSON.parse(proofs.stdout)).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        kind: 'tool_usage',
        eventIndex: 1,
        family: 'chrome-use',
      })],
    })

    const locate = runCli([
      'context', 'locate', prepared.runId, '--session', 'cli-context', '--event', '1',
      '--workspace', workspaceParent,
    ])
    expect(locate.status).toBe(0)
    expect(JSON.parse(locate.stdout)).toMatchObject({
      sessionId: 'cli-context',
      requestedEventIndex: 1,
      eventIndex: 1,
      sourceChangedSincePrepare: true,
      firstPart: 1,
      lastPart: 1,
    })

    const outcomes = runCli([
      'context', 'outcomes', prepared.runId, '--status', 'matched', '--workspace', workspaceParent,
    ])
    expect(outcomes.status).toBe(0)
    expect(JSON.parse(outcomes.stdout)).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ sessionId: 'cli-context', selectionStatus: 'matched' })],
    })

    const close = runCli([
      'context', 'close', prepared.runId, '--workspace', workspaceParent,
    ])
    expect(close.status).toBe(0)
    expect(JSON.parse(close.stdout)).toEqual({ runId: prepared.runId, status: 'closed' })
    const closeAgain = runCli([
      'context', 'close', prepared.runId, '--workspace', workspaceParent,
    ])
    expect(JSON.parse(closeAgain.stdout)).toEqual({
      runId: prepared.runId,
      status: 'not_found',
    })
  })

  it('拒绝 query-json/query-file 冲突与非法 part', () => {
    const queryFile = path.join(tempDir, 'query.json')
    fs.writeFileSync(queryFile, '{"version":1}')
    const conflict = runCli([
      'context',
      'prepare',
      '--query-json',
      '{"version":1}',
      '--query-file',
      queryFile,
      '--workspace',
      workspaceParent,
    ])
    expect(conflict.status).not.toBe(0)
    expect(conflict.stderr).toContain('--query-json 与 --query-file 不能同时使用')

    const invalidPart = runCli([
      'context',
      'read',
      '00000000-0000-4000-8000-000000000000',
      '--session',
      'x',
      '--part',
      '0',
      '--workspace',
      workspaceParent,
    ])
    expect(invalidPart.status).not.toBe(0)
    expect(invalidPart.stderr).toContain('part 必须是从 1 开始的整数')

    const invalidStatus = runCli([
      'context',
      'outcomes',
      '00000000-0000-4000-8000-000000000000',
      '--status',
      'maybe',
      '--workspace',
      workspaceParent,
    ])
    expect(invalidStatus.status).not.toBe(0)
    expect(invalidStatus.stderr).toContain('--status 必须是')
  })
})
