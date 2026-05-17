import path from 'node:path'
import { classifyHints, projectKeyFromHint } from '../../src/classifier'
import type { ProjectHint } from '../../src/types'
import { UNKNOWN_PROJECT_KEY } from '../../src/types'
import { claudeAdapter } from '../../src/adapters/claude'
import { codexAdapter } from '../../src/adapters/codex'
import { copilotAdapter } from '../../src/adapters/copilot'
import { cursorAdapter } from '../../src/adapters/cursor'

const SOURCES_DIR = path.resolve('test/sources')

const cwdHint: ProjectHint = {
  kind: 'cwd',
  value: '/Users/u/Desktop/myapp',
  confidence: 0.9,
  agent: 'claude',
  source: 'metadata',
}

const gitRootHint: ProjectHint = {
  kind: 'git_root',
  value: '/Users/u/Desktop/repo',
  confidence: 0.95,
  agent: 'copilot',
  source: 'metadata',
}

const branchHint: ProjectHint = {
  kind: 'branch',
  value: 'main',
  confidence: 0.2,
  agent: 'copilot',
  source: 'metadata',
}

// ─── 单元测试 ──────────────────────────────────────────────────────────────────

describe('classifyHints', () => {
  it('空数组 → unknown / confidence 0', () => {
    const r = classifyHints([])
    expect(r.projectKey).toBe(UNKNOWN_PROJECT_KEY)
    expect(r.confidence).toBe(0)
    expect(r.decisionHint).toBeNull()
  })

  it('只有 branch hint → unknown（branch 不单独决定）', () => {
    const r = classifyHints([branchHint])
    expect(r.projectKey).toBe(UNKNOWN_PROJECT_KEY)
    expect(r.decisionHint).toBeNull()
  })

  it('cwd hint → basename', () => {
    const r = classifyHints([cwdHint])
    expect(r.projectKey).toBe('myapp')
    expect(r.confidence).toBe(0.9)
    expect(r.decisionHint).toBe(cwdHint)
  })

  it('git_root 优先于 cwd（即使 cwd confidence 更高也不行）', () => {
    const r = classifyHints([
      cwdHint,
      gitRootHint,
      { ...cwdHint, confidence: 0.99 },
    ])
    expect(r.projectKey).toBe('repo')
    expect(r.decisionHint?.kind).toBe('git_root')
  })

  it('branch + cwd 混合 → 选 cwd', () => {
    const r = classifyHints([branchHint, cwdHint])
    expect(r.projectKey).toBe('myapp')
  })
})

describe('projectKeyFromHint', () => {
  it('cwd / git_root → basename', () => {
    expect(projectKeyFromHint(cwdHint)).toBe('myapp')
    expect(projectKeyFromHint(gitRootHint)).toBe('repo')
  })

  it('cursor source_project_path → 启发式取最后 3 段', () => {
    expect(
      projectKeyFromHint({
        kind: 'source_project_path',
        value: 'Users-moego-winches-Desktop-Company-Moe-moego-chrome-extension',
        confidence: 0.85,
        agent: 'cursor',
        source: 'source_path',
      }),
    ).toBe('moego-chrome-extension')
  })

  it('source_project_path 总段数 < 3 → 取全部', () => {
    expect(
      projectKeyFromHint({
        kind: 'source_project_path',
        value: 'foo-bar',
        confidence: 0.85,
        agent: 'cursor',
        source: 'source_path',
      }),
    ).toBe('foo-bar')
  })
})

// ─── 4 fixture 集成断言（plan 04 验收表） ─────────────────────────────────────

describe('4 fixture 真实分类', () => {
  it('claude → Boarding_Desktop（cwd basename）', async () => {
    const sessions = await claudeAdapter.discover(path.join(SOURCES_DIR, 'claude'))
    const hints = await claudeAdapter.extractProjectHints(sessions[0])
    const r = classifyHints(hints)
    expect(r.projectKey).toBe('Boarding_Desktop')
    expect(r.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('codex → cloud-code-master（cwd basename）', async () => {
    const sessions = await codexAdapter.discover(path.join(SOURCES_DIR, 'codex'))
    const hints = await codexAdapter.extractProjectHints(sessions[0])
    const r = classifyHints(hints)
    expect(r.projectKey).toBe('cloud-code-master')
    expect(r.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('copilot → agent-memory-system（git_root 优先）', async () => {
    const sessions = await copilotAdapter.discover(path.join(SOURCES_DIR, 'copilot'))
    const hints = await copilotAdapter.extractProjectHints(sessions[0])
    const r = classifyHints(hints)
    expect(r.projectKey).toBe('agent-memory-system')
    expect(r.decisionHint?.kind).toBe('git_root')
    expect(r.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('cursor → moego-chrome-extension（source_project_path 启发式）', async () => {
    const sessions = await cursorAdapter.discover(path.join(SOURCES_DIR, 'cursor'))
    const hints = await cursorAdapter.extractProjectHints(sessions[0])
    const r = classifyHints(hints)
    expect(r.projectKey).toBe('moego-chrome-extension')
    expect(r.confidence).toBeGreaterThanOrEqual(0.8)
  })
})
