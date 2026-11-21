import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { geminiAdapter } from '../../src/adapters/gemini'
import { grokAdapter } from '../../src/adapters/grok'
import { resolveAgentSourceDir, runScan } from '../../src/scanner'
import { readSessionEventSources } from '../../src/session-events'
import { runSessionQuery, parseSessionQuery } from '../../src/session-query'
import { readSessionSources } from '../../src/session-source-reader'
import { readGrokSession } from '../../src/grok-session'
import { resolveWorkspace } from '../../src/workspace'
import { runSessionsShow } from '../../src/commands/sessions'

describe('Gemini CLI 与 Grok Build adapters', () => {
  let home: string
  let sources: string
  let geminiFile: string
  let grokDirectory: string
  const geminiId = 'gemini-session-1'
  const grokId = '0194b8a7-0000-7000-8000-000000000001'

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-gemini-grok-home-'))
    sources = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-gemini-grok-sources-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
    geminiFile = path.join(
      sources, 'gemini', 'tmp', 'project-hash', 'chats', `session-${geminiId}.jsonl`,
    )
    fs.mkdirSync(path.dirname(geminiFile), { recursive: true })
    writeJsonl(geminiFile, [
      {
        sessionId: geminiId,
        projectHash: 'project-hash',
        startTime: '2026-11-14T08:00:00.000Z',
        lastUpdated: '2026-11-14T08:05:00.000Z',
        cwd: '/tmp/gemini-project',
      },
      {
        id: 'gemini-user-1',
        type: 'user',
        timestamp: '2026-11-14T08:01:00.000Z',
        content: 'Gemini session needle: inspect the parser',
      },
      {
        id: 'gemini-assistant-1',
        type: 'gemini',
        timestamp: '2026-11-14T08:02:00.000Z',
        content: [{ type: 'text', text: 'I will inspect the parser.' }],
        toolCalls: [{
          id: 'gemini-tool-1',
          name: 'read_file',
          args: { path: '/tmp/gemini-project/src/index.ts' },
          status: 'pending',
        }],
      },
      {
        $patch: {
          id: 'gemini-assistant-1',
          toolCalls: [{ id: 'gemini-tool-1', result: 'parser contents' }],
        },
      },
      { id: 'gemini-rewound', type: 'user', content: 'stale message removed by rewind' },
      { $rewindTo: 'gemini-rewound' },
    ])

    grokDirectory = path.join(
      sources,
      'grok',
      'sessions',
      encodeURIComponent('/tmp/grok-project'),
      grokId,
    )
    fs.mkdirSync(grokDirectory, { recursive: true })
    fs.writeFileSync(path.join(grokDirectory, 'summary.json'), JSON.stringify({
      info: { id: grokId, cwd: '/tmp/grok-project' },
      generated_title: 'Grok parser investigation',
      updated_at: '2026-11-14T08:10:00.000Z',
      head_branch: 'feature/grok-session',
      git_remotes: ['https://example.test/org/repo.git'],
    }))
    writeJsonl(path.join(grokDirectory, 'updates.jsonl'), [
      {
        method: 'session/update',
        params: {
          sessionId: grokId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Grok session needle: inspect the adapter' },
          },
          _meta: { promptId: 'prompt-1', agentTimestampMs: 1794643260000 },
        },
      },
      {
        method: 'session/update',
        params: {
          sessionId: grokId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'grok-tool-1',
            title: 'read_file',
            rawInput: { path: '/tmp/grok-project/src/index.ts' },
            status: 'in_progress',
          },
        },
        timestamp: 1794643261,
      },
      {
        method: 'session/update',
        params: {
          sessionId: grokId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'grok-tool-1',
            fields: { status: 'completed', rawOutput: 'adapter contents' },
          },
        },
        timestamp: 1794643262,
      },
      {
        method: 'session/update',
        params: {
          sessionId: grokId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'The adapter is registered.' },
          },
          _meta: { promptId: 'prompt-1', agentTimestampMs: 1794643263000 },
        },
      },
      {
        method: 'session/update',
        params: {
          sessionId: grokId,
          update: { sessionUpdate: 'turn_completed' },
        },
      },
    ])
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(sources, { recursive: true, force: true })
  })

  it('从官方本地格式发现并解析两个 Agent，patch 与 rewind 后只保留当前消息', async () => {
    const geminiSource = path.join(sources, 'gemini')
    const geminiProbe = await geminiAdapter.probe(geminiSource)
    const [gemini] = await geminiAdapter.discover(geminiSource)
    const geminiParsed = await geminiAdapter.parse(gemini)
    const geminiHints = await geminiAdapter.extractProjectHints(gemini)

    expect(geminiProbe.matched).toBe(true)
    expect(gemini).toMatchObject({ id: geminiId, agent: 'gemini', sourceKind: 'jsonl' })
    expect(gemini.contentHash).toBeTruthy()
    expect(geminiParsed).toMatchObject({
      sessionId: geminiId,
      messageCount: 2,
      toolCallCount: 1,
      metadata: { cwd: '/tmp/gemini-project' },
    })
    expect(geminiHints).toEqual([
      expect.objectContaining({ kind: 'cwd', value: '/tmp/gemini-project', source: 'metadata' }),
    ])
    expect(geminiHints.some((hint) => hint.value.includes('needle'))).toBe(false)

    const grokSource = path.join(sources, 'grok')
    const grokProbe = await grokAdapter.probe(grokSource)
    const [grok] = await grokAdapter.discover(grokSource)
    const grokParsed = await grokAdapter.parse(grok)
    const grokHints = await grokAdapter.extractProjectHints(grok)

    expect(grokProbe.matched).toBe(true)
    expect(grok).toMatchObject({ id: grokId, agent: 'grok', sourceKind: 'grok-updates-jsonl' })
    expect(grok.contentHash).toBeTruthy()
    expect(grokParsed).toMatchObject({
      sessionId: grokId,
      messageCount: 2,
      toolCallCount: 1,
      metadata: {
        cwd: '/tmp/grok-project',
        branch: 'feature/grok-session',
        gitRemote: 'https://example.test/org/repo.git',
      },
    })
    expect(grokHints.map((hint) => hint.kind)).toEqual(['cwd', 'git_remote', 'branch'])
    expect(grokHints.some((hint) => hint.value.includes('needle'))).toBe(false)
  })

  it('扫描后 Query、Session Show 与实时来源读取都能回源，且 DB 不保存正文', async () => {
    const scan = await runScan({
      agents: ['gemini', 'grok'],
      homeDir: home,
      source: sources,
    })

    expect(scan).toMatchObject({ total: 2, new: 2, errors: 0 })
    const query = parseSessionQuery({
      version: 2,
      scope: { agents: ['gemini', 'grok'] },
      where: {
        mentions: {
          terms: ['session needle'],
          fields: ['message'],
          origins: ['human_user'],
        },
      },
    })
    const execution = await runSessionQuery(query, { homeDir: home })
    expect(execution.coverage).toMatchObject({
      candidates: 2,
      inspected: 2,
      matched: 2,
      notMatched: 0,
      unknown: 0,
    })
    const outcomeStates = execution.outcomes
      .map(({ agent, selectionStatus }) => ({ agent, selectionStatus }))
      .sort((left, right) => left.agent.localeCompare(right.agent))
    expect(outcomeStates).toEqual([
        { agent: 'gemini', selectionStatus: 'matched' },
        { agent: 'grok', selectionStatus: 'matched' },
      ])

    const references = [
      { id: geminiId, agent: 'gemini' as const },
      { id: grokId, agent: 'grok' as const },
    ]
    const sourceMessages = await readSessionSources(references, { homeDir: home })
    expect(sourceMessages.map((result) => result.status)).toEqual(['readable', 'readable'])
    expect(sourceMessages[0].messages.some((message) => (
      typeof message.content === 'string' && message.content.includes('Gemini session needle')
    ))).toBe(true)
    expect(sourceMessages[1].messages.some((message) => (
      typeof message.content === 'string' && message.content.includes('Grok session needle')
    ))).toBe(true)

    const events = await readSessionEventSources(references, { homeDir: home })
    expect(events.map((result) => result.status)).toEqual(['readable', 'readable'])
    expect(events[0].events.map((event) => event.kind)).toEqual([
      'message', 'message', 'tool_call', 'tool_result',
    ])
    expect(events[0].events.find((event) => event.kind === 'tool_result')?.content)
      .toBe('parser contents')
    expect(events[1].events.map((event) => event.kind)).toEqual([
      'metadata', 'message', 'tool_call', 'tool_result', 'message',
    ])
    expect(events[1].events.find((event) => event.kind === 'tool_result')?.content)
      .toBe('adapter contents')

    const shown: Array<Record<string, unknown>> = []
    for (const reference of references) {
      await runSessionsShow(reference.id, { homeDir: home, stream: true }, {
        writeOutput: (chunk) => { shown.push(JSON.parse(chunk) as Record<string, unknown>) },
      })
    }
    expect(shown.some((row) => row.agent === 'gemini' && row.record !== undefined)).toBe(true)
    expect(shown.some((row) => row.agent === 'grok' && row.record !== undefined)).toBe(true)

    const database = new Database(resolveWorkspace(home).dbPath, { readonly: true })
    try {
      const rows = database.prepare('SELECT id, agent, source_path, content_hash FROM sessions')
        .all()
      const stored = JSON.stringify(rows)
      expect(stored).not.toContain('Gemini session needle')
      expect(stored).not.toContain('Grok session needle')
      const columns = database.pragma('table_info(sessions)') as Array<{ name: string }>
      expect(columns.map((column) => column.name)).not.toContain('content')
    } finally {
      database.close()
    }
  })

  it('默认来源尊重 Gemini CLI 与 Grok Build 的 home 环境变量', () => {
    const originalGeminiHome = process.env.GEMINI_CLI_HOME
    const originalGrokHome = process.env.GROK_HOME
    const geminiHome = path.join(home, 'gemini-home')
    const grokHome = path.join(home, 'grok-home')
    process.env.GEMINI_CLI_HOME = geminiHome
    process.env.GROK_HOME = grokHome
    try {
      expect(resolveAgentSourceDir(geminiAdapter, {}, path.join(home, 'workspace')))
        .toBe(path.join(geminiHome, '.gemini'))
      expect(resolveAgentSourceDir(grokAdapter, {}, path.join(home, 'workspace')))
        .toBe(grokHome)
    } finally {
      if (originalGeminiHome === undefined) delete process.env.GEMINI_CLI_HOME
      else process.env.GEMINI_CLI_HOME = originalGeminiHome
      if (originalGrokHome === undefined) delete process.env.GROK_HOME
      else process.env.GROK_HOME = originalGrokHome
    }
  })

  it('Grok 更新流没有对话消息时回退 chat_history，并忽略 system 内容', () => {
    const directory = path.join(sources, 'grok', 'fallback-session')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ info: { id: 'grok-fallback' } }))
    writeJsonl(path.join(directory, 'updates.jsonl'), [{
      method: 'session/update',
      params: { update: { sessionUpdate: 'turn_completed' } },
    }])
    writeJsonl(path.join(directory, 'chat_history.jsonl'), [
      { type: 'system', content: 'secret system prompt' },
      { type: 'user', content: 'fallback user message' },
      { type: 'assistant', content: 'fallback assistant message' },
    ])

    const session = readGrokSession(path.join(directory, 'updates.jsonl'), 'grok-fallback')

    expect(session.events).toEqual([
      expect.objectContaining({ kind: 'message', role: 'user', content: 'fallback user message' }),
      expect.objectContaining({
        kind: 'message', role: 'assistant', content: 'fallback assistant message',
      }),
    ])
    expect(JSON.stringify(session.events)).not.toContain('secret system prompt')
  })

  it('损坏的标准 Gemini 会话会进入 scanner 错误账本', async () => {
    const corruptFile = path.join(
      sources, 'gemini', 'tmp', 'project-hash', 'chats', 'session-corrupt-session.jsonl',
    )
    fs.writeFileSync(corruptFile, '{not-json}\n')
    const discovered = await geminiAdapter.discover(path.join(sources, 'gemini'))

    expect(discovered.map((session) => session.id)).toContain('corrupt-session')
    await expect(geminiAdapter.probe(path.join(sources, 'gemini')))
      .resolves.toMatchObject({ matched: true })

    const scan = await runScan({
      agents: ['gemini'],
      homeDir: home,
      source: sources,
    })
    expect(scan.errors).toBe(0)

    const database = new Database(resolveWorkspace(home).dbPath, { readonly: true })
    try {
      const run = database.prepare(`
        SELECT details FROM run_metadata WHERE run_type = 'scan' ORDER BY started_at DESC LIMIT 1
      `).get() as { details: string }
      const details = JSON.parse(run.details) as { errors: Array<Record<string, unknown>> }
      expect(details.errors).toContainEqual(expect.objectContaining({
        id: 'corrupt-session',
        agent: 'gemini',
        stage: 'hints',
        message: expect.stringContaining('Gemini JSONL 解析失败'),
      }))
    } finally {
      database.close()
    }
  })
})

function writeJsonl(filePath: string, records: unknown[]): void {
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}
