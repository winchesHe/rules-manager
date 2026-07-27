import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  listGlobalInstructionSources,
  showGlobalInstructionSource,
  type GlobalInstructionSource,
} from '../../src/global-instructions'

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-global-rules-'))
}

function writeFile(filePath: string, content = '# instructions\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function fileHash(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function getSource(
  sources: GlobalInstructionSource[],
  agent: GlobalInstructionSource['agent'],
): GlobalInstructionSource {
  const source = sources.find((item) => item.agent === agent)
  expect(source).toBeDefined()
  return source!
}

describe('global instruction sources', () => {
  let home: string

  beforeEach(() => {
    home = makeTempHome()
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('无需初始化 workspace 即可为六 agent 各列一个主要全局来源', () => {
    writeFile(path.join(home, '.claude/CLAUDE.md'))
    writeFile(path.join(home, '.codex/AGENTS.md'))
    writeFile(path.join(home, '.copilot/copilot-instructions.md'))
    writeFile(path.join(home, '.config/opencode/AGENTS.md'))
    writeFile(path.join(home, '.pi/agent/AGENTS.md'))

    const result = listGlobalInstructionSources({ homeDir: home, env: {} })

    expect(result.count).toBe(6)
    expect(result.sources.map(({ agent }) => agent)).toEqual([
      'claude',
      'codex',
      'copilot',
      'cursor',
      'opencode',
      'pi',
    ])
    for (const agent of ['claude', 'codex', 'copilot', 'opencode', 'pi'] as const) {
      expect(getSource(result.sources, agent)).toMatchObject({
        id: 'instructions',
        status: 'present',
        effective: true,
        kind: 'instructions',
      })
    }
    expect(getSource(result.sources, 'cursor')).toMatchObject({
      id: 'user-rules',
      path: null,
      status: 'unsupported',
      effective: false,
      kind: 'ui-capability',
    })
    expect(result.errors).toEqual([])
  })

  it('按 agent 筛选且保留缺失的主要固定槽位', () => {
    const result = listGlobalInstructionSources({ agent: 'pi', homeDir: home, env: {} })

    expect(result.agent).toBe('pi')
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({ id: 'instructions', status: 'missing' })
  })

  it('优先使用文档化的主要 config 环境变量', () => {
    const claudeDir = path.join(home, 'custom-claude')
    const codexDir = path.join(home, 'custom-codex')
    const xdgDir = path.join(home, 'custom-xdg')
    const piDir = path.join(home, 'custom-pi')
    writeFile(path.join(claudeDir, 'CLAUDE.md'))
    writeFile(path.join(codexDir, 'AGENTS.md'))
    writeFile(path.join(xdgDir, 'opencode/AGENTS.md'))
    writeFile(path.join(piDir, 'AGENTS.md'))

    const result = listGlobalInstructionSources({
      homeDir: home,
      env: {
        CLAUDE_CONFIG_DIR: claudeDir,
        CODEX_HOME: codexDir,
        XDG_CONFIG_HOME: xdgDir,
        PI_CODING_AGENT_DIR: piDir,
      },
    })

    expect(getSource(result.sources, 'claude').path).toBe(path.join(claudeDir, 'CLAUDE.md'))
    expect(getSource(result.sources, 'codex').path).toBe(path.join(codexDir, 'AGENTS.md'))
    expect(getSource(result.sources, 'opencode').path).toBe(
      path.join(xdgDir, 'opencode/AGENTS.md'),
    )
    expect(getSource(result.sources, 'pi').path).toBe(path.join(piDir, 'AGENTS.md'))
  })

  it('不展示或处理 managed、override、模块规则、fallback、config 和 Pi system 文件', () => {
    writeFile(path.join(home, '.claude/rules/base.md'))
    writeFile(path.join(home, '.codex/AGENTS.override.md'))
    writeFile(path.join(home, '.copilot/instructions/typescript.instructions.md'))
    writeFile(path.join(home, 'copilot-custom/shared.instructions.md'))
    writeFile(path.join(home, '.claude/CLAUDE.md'))
    writeFile(path.join(home, '.config/opencode/opencode.json'), '{}')
    writeFile(path.join(home, '.pi/agent/SYSTEM.md'))
    writeFile(path.join(home, '.pi/agent/APPEND_SYSTEM.md'))

    const result = listGlobalInstructionSources({
      homeDir: home,
      env: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: path.join(home, 'copilot-custom') },
    })

    expect(result.count).toBe(6)
    expect(result.sources.every(({ id }) => id === 'instructions' || id === 'user-rules')).toBe(
      true,
    )
    expect(result.sources.map(({ path: sourcePath }) => sourcePath)).not.toEqual(
      expect.arrayContaining([
        path.join(home, '.codex/AGENTS.override.md'),
        path.join(home, '.config/opencode/opencode.json'),
        path.join(home, '.pi/agent/SYSTEM.md'),
        path.join(home, '.pi/agent/APPEND_SYSTEM.md'),
      ]),
    )
  })

  it('按 agent 读取主来源正文且不修改源文件或创建 workspace', () => {
    const sourcePath = path.join(home, '.pi/agent/AGENTS.md')
    writeFile(sourcePath, '# private pi instructions\n')
    const beforeHash = fileHash(sourcePath)

    const result = showGlobalInstructionSource('pi', {
      homeDir: home,
      env: {},
    })

    expect(result.source).toMatchObject({ agent: 'pi', id: 'instructions' })
    expect(result.content).toBe('# private pi instructions\n')
    expect(fileHash(sourcePath)).toBe(beforeHash)
    expect(fs.existsSync(path.join(home, '.memory-manager'))).toBe(false)
  })

  it('允许读取主要来源文件 symlink', () => {
    const targetPath = path.join(home, 'shared/AGENTS.md')
    const linkedPath = path.join(home, '.pi/agent/AGENTS.md')
    writeFile(targetPath, '# linked instructions\n')
    fs.mkdirSync(path.dirname(linkedPath), { recursive: true })
    fs.symlinkSync(targetPath, linkedPath)

    const result = showGlobalInstructionSource('pi', {
      homeDir: home,
      env: {},
    })

    expect(result.source.path).toBe(linkedPath)
    expect(result.content).toBe('# linked instructions\n')
  })

  it.each([
    ['pi', '规则来源不可读取（missing）：pi/instructions'],
    ['cursor', '规则来源不可读取（unsupported）：cursor/user-rules'],
  ] as const)('拒绝不可 show 的 agent 来源 %s', (agent, message) => {
    expect(() => showGlobalInstructionSource(agent, { homeDir: home, env: {} })).toThrow(
      message,
    )
  })

  it('拒绝超过 1 MiB 的文件和非法 UTF-8', () => {
    const sourcePath = path.join(home, '.pi/agent/AGENTS.md')
    writeFile(sourcePath, 'x'.repeat(1024 * 1024 + 1))
    expect(() =>
      showGlobalInstructionSource('pi', { homeDir: home, env: {} }),
    ).toThrow('规则文件超过 1 MiB')

    fs.writeFileSync(sourcePath, Buffer.from([0xc3, 0x28]))
    expect(() =>
      showGlobalInstructionSource('pi', { homeDir: home, env: {} }),
    ).toThrow('规则文件不是有效 UTF-8')
  })
})
