import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tsxCli = path.join(projectRoot, 'node_modules/tsx/dist/cli.mjs')

function runCli(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, 'src/cli.ts', ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
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
})
