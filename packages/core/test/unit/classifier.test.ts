import path from 'node:path'
import { classify, normalizeSlug } from '../../src/classifier'
import { DEFAULT_SLUG } from '../../src/workspace'
import type { ProjectHint } from '../../src/types'
import { claudeAdapter } from '../../src/adapters/claude'
import { codexAdapter } from '../../src/adapters/codex'
import { copilotAdapter } from '../../src/adapters/copilot'
import { cursorAdapter } from '../../src/adapters/cursor'

const SOURCES_DIR = path.resolve('test/sources')

const cwdHint: ProjectHint = {
  kind: 'cwd',
  value: '/Users/u/Desktop/Boarding_Desktop',
  confidence: 0.9,
  agent: 'claude',
  source: 'metadata',
}

const gitRootHint: ProjectHint = {
  kind: 'git_root',
  value: '/Users/u/Code/agent-memory-system',
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

// ─── normalizeSlug ───────────────────────────────────────────────────────────

describe('normalizeSlug', () => {
  it('lowercase + 非 [a-z0-9] 折叠成 -', () => {
    expect(normalizeSlug('Boarding_Desktop')).toBe('boarding-desktop')
    expect(normalizeSlug('Foo Bar Baz')).toBe('foo-bar-baz')
    expect(normalizeSlug('agent_memory.system')).toBe('agent-memory-system')
  })

  it('开头结尾 - 去掉', () => {
    expect(normalizeSlug('--abc--')).toBe('abc')
    expect(normalizeSlug('_abc_')).toBe('abc')
  })

  it('空 / null / undefined → default', () => {
    expect(normalizeSlug('')).toBe(DEFAULT_SLUG)
    expect(normalizeSlug(null)).toBe(DEFAULT_SLUG)
    expect(normalizeSlug(undefined)).toBe(DEFAULT_SLUG)
    expect(normalizeSlug('___')).toBe(DEFAULT_SLUG)
  })

  it('防 path 注入：. .. / \\ 都被消成 -', () => {
    expect(normalizeSlug('..')).toBe(DEFAULT_SLUG)
    expect(normalizeSlug('a/b')).toBe('a-b')
    expect(normalizeSlug('a/../b')).toBe('a-b')
    expect(normalizeSlug('/etc/passwd')).toBe('etc-passwd')
  })
})

// ─── classify(hints) ─────────────────────────────────────────────────────────

describe('classify', () => {
  it('空数组 → default', () => {
    expect(classify([])).toBe(DEFAULT_SLUG)
  })

  it('只有 branch → default（branch 不单独决定）', () => {
    expect(classify([branchHint])).toBe(DEFAULT_SLUG)
  })

  it('cwd hint → basename normalized', () => {
    expect(classify([cwdHint])).toBe('boarding-desktop')
  })

  it('git_root 优先于 cwd（即使 cwd confidence 更高）', () => {
    expect(classify([{ ...cwdHint, confidence: 0.99 }, gitRootHint])).toBe(
      'agent-memory-system',
    )
  })

  it('branch + cwd 混合 → 取 cwd', () => {
    expect(classify([branchHint, cwdHint])).toBe('boarding-desktop')
  })
})

// ─── 4 fixture 真实分类（spec § 验收链路 第 9 条对账） ───────────────────────

describe('4 fixture 真实分类（slug 形态）', () => {
  it('claude → boarding-desktop', async () => {
    const sessions = await claudeAdapter.discover(path.join(SOURCES_DIR, 'claude'))
    const hints = await claudeAdapter.extractProjectHints(sessions[0])
    expect(classify(hints)).toBe('boarding-desktop')
  })

  it('codex → cloud-code-master', async () => {
    const sessions = await codexAdapter.discover(path.join(SOURCES_DIR, 'codex'))
    const hints = await codexAdapter.extractProjectHints(sessions[0])
    expect(classify(hints)).toBe('cloud-code-master')
  })

  it('copilot → agent-memory-system', async () => {
    const sessions = await copilotAdapter.discover(path.join(SOURCES_DIR, 'copilot'))
    const hints = await copilotAdapter.extractProjectHints(sessions[0])
    expect(classify(hints)).toBe('agent-memory-system')
  })

  it('cursor → moego-chrome-extension', async () => {
    const sessions = await cursorAdapter.discover(path.join(SOURCES_DIR, 'cursor'))
    const hints = await cursorAdapter.extractProjectHints(sessions[0])
    expect(classify(hints)).toBe('moego-chrome-extension')
  })
})
