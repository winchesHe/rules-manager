import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { jest } from '@jest/globals'
import {
  listAutoMemorySources,
  readAutoMemorySource,
} from '../../src/auto-memories'

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-auto-memory-'))
}

function writeFile(filePath: string, content = '# Memory\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function fileHash(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

describe('Agent auto memory sources', () => {
  let home: string

  beforeEach(() => {
    home = makeTempHome()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('列出 Claude 项目主入口与 Codex 固定槽位，并忽略 topic、私有 DB 和项目目录 symlink', () => {
    const alpha = path.join(home, '.claude/projects/project-alpha/memory/MEMORY.md')
    const beta = path.join(home, '.claude/projects/project-beta/memory/MEMORY.md')
    writeFile(alpha, '# Alpha\n')
    writeFile(beta, '# Beta\n')
    writeFile(path.join(home, '.claude/projects/project-alpha/memory/debugging.md'))
    writeFile(path.join(home, '.codex/sqlite/memories_1.sqlite'), 'private')
    const externalProject = path.join(home, 'external-project')
    writeFile(path.join(externalProject, 'memory/MEMORY.md'))
    fs.symlinkSync(externalProject, path.join(home, '.claude/projects/linked-project'))

    const result = listAutoMemorySources({ homeDir: home, env: {} })

    expect(result.sources.map(({ agent, id, status }) => ({ agent, id, status }))).toEqual([
      { agent: 'claude', id: 'project:project-alpha', status: 'present' },
      { agent: 'claude', id: 'project:project-beta', status: 'present' },
      { agent: 'codex', id: 'memory', status: 'missing' },
    ])
    expect(result.sources.map(({ path: sourcePath }) => sourcePath)).not.toEqual(
      expect.arrayContaining([
        path.join(home, '.claude/projects/project-alpha/memory/debugging.md'),
        path.join(home, '.codex/sqlite/memories_1.sqlite'),
        path.join(home, '.claude/projects/linked-project/memory/MEMORY.md'),
      ]),
    )
    expect(result.errors).toEqual([])
  })

  it('优先使用 Claude 与 Codex 文档化的配置根环境变量', () => {
    const claudeRoot = path.join(home, 'custom-claude')
    const codexRoot = path.join(home, 'custom-codex')
    writeFile(path.join(claudeRoot, 'projects/opaque/memory/MEMORY.md'))
    writeFile(path.join(codexRoot, 'memories/MEMORY.md'))

    const result = listAutoMemorySources({
      homeDir: home,
      env: { CLAUDE_CONFIG_DIR: claudeRoot, CODEX_HOME: codexRoot },
    })

    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent: 'claude',
        path: path.join(claudeRoot, 'projects/opaque/memory/MEMORY.md'),
        discoveredFrom: 'environment',
      }),
      expect.objectContaining({
        agent: 'codex',
        path: path.join(codexRoot, 'memories/MEMORY.md'),
        discoveredFrom: 'environment',
      }),
    ]))
  })

  it('从 Claude 项目 Session 顶层 cwd 元数据关联真实项目路径', () => {
    const memoryPath = path.join(home, '.claude/projects/encoded-project/memory/MEMORY.md')
    const sessionPath = path.join(home, '.claude/projects/encoded-project/session.jsonl')
    writeFile(memoryPath, '# Project memory\n')
    writeFile(sessionPath, [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '不得作为项目路径证据' },
        cwd: '/work/project-alpha',
        sessionId: 'session-alpha',
      }),
    ].join('\n'))

    const result = listAutoMemorySources({ homeDir: home, env: {}, agent: 'claude' })

    expect(result.sources).toEqual([
      expect.objectContaining({
        id: 'project:encoded-project',
        projectPath: '/work/project-alpha',
      }),
    ])
  })

  it('Claude 项目 Session 出现不同 cwd 时保持未关联', () => {
    const projectRoot = path.join(home, '.claude/projects/encoded-project')
    writeFile(path.join(projectRoot, 'memory/MEMORY.md'), '# Project memory\n')
    writeFile(path.join(projectRoot, 'session-one.jsonl'), JSON.stringify({
      type: 'user',
      cwd: '/work/project-alpha',
      sessionId: 'session-one',
    }))
    writeFile(path.join(projectRoot, 'session-two.jsonl'), JSON.stringify({
      type: 'user',
      cwd: '/work/project-beta',
      sessionId: 'session-two',
    }))

    const result = listAutoMemorySources({ homeDir: home, env: {}, agent: 'claude' })

    expect(result.sources).toEqual([
      expect.not.objectContaining({ projectPath: expect.anything() }),
    ])
  })

  it('按稳定 id 只读打开 Claude Memory，并允许最终文件为 symlink', () => {
    const target = path.join(home, 'shared/MEMORY.md')
    const linked = path.join(home, '.claude/projects/project-alpha/memory/MEMORY.md')
    writeFile(target, '# Linked memory\n')
    fs.mkdirSync(path.dirname(linked), { recursive: true })
    fs.symlinkSync(target, linked)
    const before = fileHash(target)

    const result = readAutoMemorySource('claude', 'project:project-alpha', {
      homeDir: home,
      env: {},
    })

    expect(result.content).toBe('# Linked memory\n')
    expect(result.source).toMatchObject({
      id: 'project:project-alpha',
      status: 'present',
      sizeBytes: Buffer.byteLength('# Linked memory\n'),
    })
    expect(fileHash(target)).toBe(before)
    expect(fs.existsSync(path.join(home, '.memory-manager'))).toBe(false)
  })

  it('单一 present 来源可省略 id，多项目、未知 id 与 missing 均明确失败', () => {
    writeFile(path.join(home, '.claude/projects/project-alpha/memory/MEMORY.md'), '# One\n')
    expect(readAutoMemorySource('claude', undefined, { homeDir: home, env: {} }).content)
      .toBe('# One\n')

    writeFile(path.join(home, '.claude/projects/project-beta/memory/MEMORY.md'), '# Two\n')
    expect(() => readAutoMemorySource('claude', undefined, { homeDir: home, env: {} }))
      .toThrow('存在多个 Agent Memory，请先选择 memory id：claude')
    expect(() => readAutoMemorySource('claude', 'project:missing', { homeDir: home, env: {} }))
      .toThrow('未知的 Agent Memory：claude/project:missing')
    expect(() => readAutoMemorySource('codex', 'memory', { homeDir: home, env: {} }))
      .toThrow('Agent Memory 尚未生成：codex/memory')
  })

  it('从 Codex 合并 MEMORY.md 派生项目来源，并按稳定 id 读取项目切片', () => {
    const sourcePath = path.join(home, '.codex/memories/MEMORY.md')
    const content = `# Task Group: Alpha one
scope: alpha first
applies_to: cwd=/work/alpha; reuse_rule=first

## Task 1
alpha first body

# Task Group: Beta
scope: beta
applies_to: cwd=/work/beta; reuse_rule=beta

## Task 1
beta body

# Task Group: Alpha two
scope: alpha second
applies_to: cwd=/work/alpha; reuse_rule=second

## Task 1
alpha second body
`
    writeFile(sourcePath, content)
    const before = fileHash(sourcePath)

    const result = listAutoMemorySources({ homeDir: home, env: {}, agent: 'codex' })
    expect(result.errors).toEqual([])
    expect(result.sources).toEqual([
      expect.objectContaining({ id: 'memory', scope: 'global', path: sourcePath }),
      expect.objectContaining({
        id: expect.stringMatching(/^project:[a-f0-9]{16}$/),
        scope: 'project',
        projectPath: '/work/alpha',
        taskGroupCount: 2,
        path: sourcePath,
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^project:[a-f0-9]{16}$/),
        scope: 'project',
        projectPath: '/work/beta',
        taskGroupCount: 1,
        path: sourcePath,
      }),
    ])

    const alpha = result.sources.find((source) => source.projectPath === '/work/alpha')
    const projectMemory = readAutoMemorySource('codex', alpha?.id, { homeDir: home, env: {} })
    expect(projectMemory.content).toContain('# Task Group: Alpha one')
    expect(projectMemory.content).toContain('# Task Group: Alpha two')
    expect(projectMemory.content).not.toContain('# Task Group: Beta')
    expect(projectMemory.source.sizeBytes).toBe(Buffer.byteLength(projectMemory.content))

    expect(readAutoMemorySource('codex', undefined, { homeDir: home, env: {} }).content)
      .toBe(content)
    expect(fileHash(sourcePath)).toBe(before)
  })

  it('拒绝超过 1 MiB、非法 UTF-8 与读取期间变化的 Memory', () => {
    const sourcePath = path.join(home, '.codex/memories/MEMORY.md')
    writeFile(sourcePath, 'x'.repeat(1024 * 1024 + 1))
    expect(() => readAutoMemorySource('codex', 'memory', { homeDir: home, env: {} }))
      .toThrow('Agent Memory 文件超过 1 MiB')

    fs.writeFileSync(sourcePath, Buffer.from([0xc3, 0x28]))
    expect(() => readAutoMemorySource('codex', 'memory', { homeDir: home, env: {} }))
      .toThrow('Agent Memory 不是有效 UTF-8')

    writeFile(sourcePath, '# Before\n')
    const originalRead = fs.readFileSync.bind(fs)
    jest.spyOn(fs, 'readFileSync').mockImplementationOnce(((filePath: fs.PathOrFileDescriptor) => {
      const content = originalRead(filePath)
      writeFile(sourcePath, '# Changed while reading\n')
      return content
    }) as typeof fs.readFileSync)
    expect(() => readAutoMemorySource('codex', 'memory', { homeDir: home, env: {} }))
      .toThrow('Agent Memory 在读取期间发生变化')
  })
})
