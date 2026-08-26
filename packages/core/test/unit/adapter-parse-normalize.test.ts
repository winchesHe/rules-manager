import path from 'node:path'
import { claudeAdapter } from '../../src/adapters/claude'
import { codexAdapter } from '../../src/adapters/codex'
import { copilotAdapter } from '../../src/adapters/copilot'
import { cursorAdapter } from '../../src/adapters/cursor'

const SOURCES_DIR = path.resolve('test/sources')

// ─── claude.parse / normalize ─────────────────────────────────────────────────

describe('claudeAdapter.parse', () => {
  it('从 jsonl 抽出 messageCount / toolCallCount / metadata.cwd / 时间戳', async () => {
    const sessions = await claudeAdapter.discover(path.join(SOURCES_DIR, 'claude'))
    expect(sessions.length).toBeGreaterThan(0)

    const parsed = await claudeAdapter.parse(sessions[0])
    expect(parsed.agent).toBe('claude')
    expect(parsed.sessionId).toBe(sessions[0].id)
    expect(parsed.messageCount).toBeGreaterThan(0)
    expect(parsed.metadata.cwd).toBe(
      '/Users/example/Projects/Atlas_Desktop',
    )
    expect(parsed.metadata.branch).toBeDefined()
    // claude jsonl 行带 timestamp，应能解析出首/末时间戳
    expect(parsed.firstTimestamp).toBeTruthy()
    expect(parsed.lastTimestamp).toBeTruthy()
  })
})

describe('claudeAdapter.normalize', () => {
  it('输出与 discovered 一致的 sessionId / contentHash / sourcePath，并附带 parsed', async () => {
    const sessions = await claudeAdapter.discover(path.join(SOURCES_DIR, 'claude'))
    const parsed = await claudeAdapter.parse(sessions[0])
    const normalized = await claudeAdapter.normalize(parsed, sessions[0])

    expect(normalized.sessionId).toBe(sessions[0].id)
    expect(normalized.agent).toBe('claude')
    expect(normalized.sourcePath).toBe(sessions[0].sourcePath)
    expect(normalized.sourceKind).toBe(sessions[0].sourceKind)
    expect(normalized.contentHash).toBe(sessions[0].contentHash)
    expect(normalized.parsed).toBe(parsed)
  })

  it('两次 normalize 同一会话 → contentHash 稳定相同', async () => {
    const sessions = await claudeAdapter.discover(path.join(SOURCES_DIR, 'claude'))
    const a = await claudeAdapter.normalize(
      await claudeAdapter.parse(sessions[0]),
      sessions[0],
    )
    const b = await claudeAdapter.normalize(
      await claudeAdapter.parse(sessions[0]),
      sessions[0],
    )
    expect(a.contentHash).toBe(b.contentHash)
    expect(a.sessionId).toBe(b.sessionId)
  })
})

// ─── codex.parse / normalize ──────────────────────────────────────────────────

describe('codexAdapter.parse', () => {
  it('抽出 message / function_call 计数 + cwd + branch + headCommit', async () => {
    const sessions = await codexAdapter.discover(path.join(SOURCES_DIR, 'codex'))
    expect(sessions.length).toBeGreaterThan(0)

    const parsed = await codexAdapter.parse(sessions[0])
    expect(parsed.agent).toBe('codex')
    expect(parsed.sessionId).toBe(sessions[0].id)
    expect(parsed.messageCount).toBeGreaterThan(0)
    expect(parsed.toolCallCount).toBeGreaterThan(0)
    expect(parsed.metadata.cwd).toBe(
      '/Users/example/Projects/orbit-cli',
    )
    expect(parsed.metadata.branch).toBe('feature/synthetic-runtime')
    expect(parsed.metadata.headCommit).toBeTruthy()
    expect(parsed.firstTimestamp).toBeTruthy()
    expect(parsed.lastTimestamp).toBeTruthy()
  })
})

describe('codexAdapter.normalize', () => {
  it('输出权威字段并附 parsed', async () => {
    const sessions = await codexAdapter.discover(path.join(SOURCES_DIR, 'codex'))
    const parsed = await codexAdapter.parse(sessions[0])
    const normalized = await codexAdapter.normalize(parsed, sessions[0])

    expect(normalized.sessionId).toBe(sessions[0].id)
    expect(normalized.contentHash).toBe(sessions[0].contentHash)
    expect(normalized.parsed.toolCallCount).toBe(parsed.toolCallCount)
  })
})

// ─── copilot.parse / normalize ────────────────────────────────────────────────

describe('copilotAdapter.parse', () => {
  it('抽出 user/assistant message 计数、tool.execution_start 计数、cwd / gitRoot / branch / headCommit', async () => {
    const sessions = await copilotAdapter.discover(path.join(SOURCES_DIR, 'copilot'))
    expect(sessions.length).toBeGreaterThan(0)

    const parsed = await copilotAdapter.parse(sessions[0])
    expect(parsed.agent).toBe('copilot')
    expect(parsed.messageCount).toBeGreaterThanOrEqual(2) // 至少 1 user + 1 assistant
    expect(parsed.toolCallCount).toBeGreaterThanOrEqual(1)
    expect(parsed.metadata.cwd).toBe(
      '/Users/example/Projects/memory-lab',
    )
    expect(parsed.metadata.gitRoot).toBe(parsed.metadata.cwd)
    expect(parsed.metadata.branch).toBe('main')
    expect(parsed.metadata.headCommit).toBe('3333333333333333333333333333333333333333')
    expect(parsed.firstTimestamp).toBe('2026-01-03T00:00:00.000Z') // 首条 session.start 的 timestamp
  })
})

describe('copilotAdapter.normalize', () => {
  it('输出权威字段并附 parsed', async () => {
    const sessions = await copilotAdapter.discover(path.join(SOURCES_DIR, 'copilot'))
    const parsed = await copilotAdapter.parse(sessions[0])
    const normalized = await copilotAdapter.normalize(parsed, sessions[0])
    expect(normalized.sessionId).toBe(sessions[0].id)
    expect(normalized.contentHash).toBe(sessions[0].contentHash)
    expect(normalized.parsed.metadata.gitRoot).toBeTruthy()
  })
})

// ─── cursor.parse / normalize ─────────────────────────────────────────────────

describe('cursorAdapter.parse', () => {
  it('抽出 user/assistant role 计数；jsonl 内无 cwd/gitRoot 时 metadata 留空', async () => {
    const sessions = await cursorAdapter.discover(path.join(SOURCES_DIR, 'cursor'))
    expect(sessions.length).toBeGreaterThan(0)

    const parsed = await cursorAdapter.parse(sessions[0])
    expect(parsed.agent).toBe('cursor')
    expect(parsed.messageCount).toBeGreaterThan(0)
    expect(parsed.metadata.cwd).toBeUndefined()
    expect(parsed.metadata.gitRoot).toBeUndefined()
  })
})

describe('cursorAdapter.normalize', () => {
  it('输出权威字段并附 parsed', async () => {
    const sessions = await cursorAdapter.discover(path.join(SOURCES_DIR, 'cursor'))
    const parsed = await cursorAdapter.parse(sessions[0])
    const normalized = await cursorAdapter.normalize(parsed, sessions[0])
    expect(normalized.sessionId).toBe(sessions[0].id)
    expect(normalized.contentHash).toBe(sessions[0].contentHash)
    expect(normalized.parsed).toBe(parsed)
  })
})

// ─── parse 失败兜底 ───────────────────────────────────────────────────────────

describe('parse 兜底：非法路径返回最小 ParsedSession（不抛）', () => {
  it('claude/cursor 接收不存在路径时返回零计数', async () => {
    const fake = {
      id: '00000000-0000-0000-0000-000000000000',
      agent: 'claude' as const,
      sourcePath: '/nonexistent/path/no.jsonl',
      sourceKind: 'jsonl',
      updatedAt: '2026-05-01T00:00:00.000Z',
      contentHash: 'x',
    }
    const p = await claudeAdapter.parse(fake)
    expect(p.messageCount).toBe(0)
    expect(p.toolCallCount).toBe(0)
    expect(p.metadata).toEqual({})
  })
})
