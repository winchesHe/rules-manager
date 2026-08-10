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

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-context-cli-'))
    workspaceParent = path.join(tempDir, 'workspace')
    expect(runCli(['init', '--non-interactive', '--workspace', workspaceParent]).status).toBe(0)
    dbPath = path.join(workspaceParent, '.memory-manager', 'memory.db')
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function addCodexSession(): void {
    const sourcePath = path.join(tempDir, 'codex-session.jsonl')
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

  it('prepare → status → read all parts → close 形成可脚本消费的完整链路', () => {
    addCodexSession()
    const query = JSON.stringify({
      version: 1,
      where: { tool: { families: ['chrome-use'] } },
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
      sessions: Array<{ id: string; partCount: number; proofs: Array<{ family: string }> }>
      closeCommand: string
    }
    expect(prepared.coverage).toEqual({
      candidates: 1,
      inspected: 1,
      matched: 1,
      notMatched: 0,
      unknown: 0,
      changedDuringRun: 0,
    })
    expect(prepared.sessions).toEqual([
      expect.objectContaining({
        id: 'cli-context',
        partCount: 1,
        proofs: [expect.objectContaining({ family: 'chrome-use' })],
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
    })

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
      events: [
        expect.objectContaining({ kind: 'message', role: 'user' }),
        expect.objectContaining({ kind: 'tool_call', toolName: 'mcp__chrome__navigate' }),
        expect.objectContaining({ kind: 'tool_result', toolCallId: 'call-1' }),
      ],
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
  })
})
