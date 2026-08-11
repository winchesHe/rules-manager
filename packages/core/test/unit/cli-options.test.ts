import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tsxCli = path.resolve(projectRoot, '../../node_modules/tsx/dist/cli.mjs')
const sourcesDir = path.join(projectRoot, 'test/sources')

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [tsxCli, 'src/cli.ts', ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function runCliAndCloseStdout(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, 'src/cli.ts', ...args], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.stdout.once('data', () => child.stdout.destroy())
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr }))
  })
}

describe('CLI workspace options', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('用 --workspace 在指定路径下初始化 .memory-manager，并供后续命令复用', () => {
    const workspaceParent = path.join(tempDir, 'custom-workspace')
    const workspace = path.join(workspaceParent, '.memory-manager')
    const init = runCli(['init', '--non-interactive', '--workspace', workspaceParent])

    expect(init.status).toBe(0)
    expect(fs.existsSync(path.join(workspace, 'memory.db'))).toBe(true)
    expect(fs.existsSync(path.join(workspaceParent, 'memory.db'))).toBe(false)

    const status = runCli(['status', '--workspace', workspaceParent])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain(workspace)
  })

  it('不再接受语义不清晰的 --yes', () => {
    const result = runCli(['init', '--yes'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unknown option')
  })

  it('sessions show 暴露 NDJSON 流式输出选项', () => {
    const result = runCli(['sessions', 'show', '--help'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--stream')
    expect(result.stdout).toContain('NDJSON')
  })

  it('context 暴露 prepare/read/status/cleanup/close 与 Query 输入选项', () => {
    const context = runCli(['context', '--help'])
    expect(context.status).toBe(0)
    expect(context.stdout).toContain('prepare')
    expect(context.stdout).toContain('read')
    expect(context.stdout).toContain('status')
    expect(context.stdout).toContain('cleanup')
    expect(context.stdout).toContain('close')

    const prepare = runCli(['context', 'prepare', '--help'])
    expect(prepare.status).toBe(0)
    expect(prepare.stdout).toContain('--query-json')
    expect(prepare.stdout).toContain('--query-file')
  })

  it('sessions show --stream 的下游提前关闭时正常退出', async () => {
    const workspaceParent = path.join(tempDir, 'stream-workspace')
    expect(
      runCli(['init', '--non-interactive', '--workspace', workspaceParent]).status,
    ).toBe(0)
    const workspace = path.join(workspaceParent, '.memory-manager')
    const sourcePath = path.join(tempDir, 'large-stream.jsonl')
    const record = `${JSON.stringify({ type: 'message', text: 'x'.repeat(512) })}\n`
    fs.writeFileSync(sourcePath, record.repeat(20_000))
    const db = new Database(path.join(workspace, 'memory.db'))
    db.prepare(`
      INSERT INTO sessions
        (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
         status, first_seen_at, last_seen_at)
      VALUES ('cli-stream', 'codex', ?, ?, 'default', 'hash', '2026-01-01',
              'new', '2026-01-01', '2026-01-01')
    `).run(sourcePath, path.join(workspace, 'projects/default/cli-stream.jsonl'))
    db.close()

    const result = await runCliAndCloseStdout([
      'sessions',
      'show',
      'cli-stream',
      '--stream',
      '--workspace',
      workspaceParent,
    ])

    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain('EPIPE')
  })

  it('仅指定 workspace 时显示帮助并正常退出', () => {
    const workspace = path.join(tempDir, 'custom-workspace')
    const result = runCli(['-w', workspace])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage: memory-manager')
    expect(fs.existsSync(workspace)).toBe(false)
  })

  it('projects sessions 输出全部或指定项目的 JSON metadata', () => {
    const workspaceParent = path.join(tempDir, 'project-sessions')
    expect(
      runCli(['init', '--non-interactive', '--workspace', workspaceParent]).status,
    ).toBe(0)
    expect(
      runCli([
        'scan',
        '--all',
        '--source',
        sourcesDir,
        '--workspace',
        workspaceParent,
      ]).status,
    ).toBe(0)

    const all = runCli(['projects', 'sessions', '--workspace', workspaceParent])
    expect(all.status).toBe(0)
    const allOutput = JSON.parse(all.stdout) as {
      project: string | null
      count: number
      sessions: Array<{ slug: string; sourcePath: string; contentHash: string }>
    }
    expect(allOutput.project).toBeNull()
    expect(allOutput.count).toBe(allOutput.sessions.length)
    expect(allOutput.sessions.length).toBeGreaterThan(0)
    expect(allOutput.sessions[0].sourcePath).toBeTruthy()
    expect(allOutput.sessions[0].contentHash).toBeTruthy()

    const filtered = runCli([
      'projects',
      'sessions',
      'boarding-desktop',
      '--workspace',
      workspaceParent,
    ])
    expect(filtered.status).toBe(0)
    const filteredOutput = JSON.parse(filtered.stdout) as {
      project: string
      count: number
      sessions: Array<{ slug: string }>
    }
    expect(filteredOutput.project).toBe('boarding-desktop')
    expect(filteredOutput.count).toBeGreaterThan(0)
    expect(filteredOutput.sessions.every(({ slug }) => slug === 'boarding-desktop')).toBe(
      true,
    )

    const missing = runCli([
      'projects',
      'sessions',
      'not-found',
      '--workspace',
      workspaceParent,
    ])
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('project not found: not-found')
  })

  it('rules list/show 无需 init，并按 agent 只读唯一主来源', () => {
    const claudeDir = path.join(tempDir, 'claude-config')
    const sourcePath = path.join(claudeDir, 'CLAUDE.md')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(sourcePath, '# cli private instructions\n')
    const env = { CLAUDE_CONFIG_DIR: claudeDir }

    const list = runCli(['rules', 'list', 'claude'], env)
    expect(list.status).toBe(0)
    const listOutput = JSON.parse(list.stdout) as {
      agent: string
      sources: Array<{ id: string; status: string; path: string }>
    }
    expect(listOutput.agent).toBe('claude')
    expect(listOutput.sources).toContainEqual(
      expect.objectContaining({ id: 'instructions', status: 'present', path: sourcePath }),
    )

    const show = runCli(['rules', 'show', 'claude'], env)
    expect(show.status).toBe(0)
    expect(JSON.parse(show.stdout)).toMatchObject({
      source: { agent: 'claude', id: 'instructions' },
      content: '# cli private instructions\n',
    })
    expect(fs.existsSync(path.join(tempDir, '.memory-manager'))).toBe(false)

    const legacyShow = runCli(['rules', 'show', 'claude', 'instructions'], env)
    expect(legacyShow.status).not.toBe(0)
    expect(legacyShow.stderr).toContain('too many arguments')

    const unknown = runCli(['rules', 'list', 'unknown'], env)
    expect(unknown.status).not.toBe(0)
    expect(unknown.stderr).toContain('未知 agent：unknown')
  })
})
