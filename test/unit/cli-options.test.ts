import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tsxCli = path.join(projectRoot, 'node_modules/tsx/dist/cli.mjs')
const sourcesDir = path.join(projectRoot, 'test/sources')

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [tsxCli, 'src/cli.ts', ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
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
