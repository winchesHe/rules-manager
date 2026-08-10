import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { readSessionEventSources } from '../../src/session-events'
import type { AgentName } from '../../src/types'
import { resolveWorkspace } from '../../src/workspace'

describe('Session Event Reader', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-session-events-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function addSession(id: string, agent: AgentName, sourcePath: string): void {
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'demo', 'hash', '2026-08-09T00:00:00.000Z',
                'updated', '2026-08-09', '2026-08-09')
    `).run(id, agent, sourcePath, `/tmp/${id}.jsonl`)
    db.close()
  }

  function writeJsonl(id: string, rows: unknown[]): string {
    const sourcePath = path.join(home, `${id}.jsonl`)
    fs.writeFileSync(sourcePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    return sourcePath
  }

  it('Codex 保留 system、message、嵌套 tool call 与 tool result 的源顺序', async () => {
    const sourcePath = writeJsonl('codex-events', [
      { type: 'session_meta', payload: { id: 'codex-events', cwd: '/tmp/demo' } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: 'Skill catalog: computer-use' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '请检查页面' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call-1',
          name: 'exec',
          input: { code: 'await tools.mcp__computer_use__computer({action:"screenshot"})' },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-1',
          output: { ok: true },
        },
      },
    ])
    addSession('codex-events', 'codex', sourcePath)

    const [result] = await readSessionEventSources(
      [{ id: 'codex-events', agent: 'codex' }],
      { homeDir: home },
    )

    expect(result.status).toBe('readable')
    expect(result.events.map(({ kind, role, toolName, toolCallId }) => ({
      kind,
      role,
      toolName,
      toolCallId,
    }))).toEqual([
      { kind: 'metadata', role: undefined, toolName: undefined, toolCallId: undefined },
      { kind: 'message', role: 'system', toolName: undefined, toolCallId: undefined },
      { kind: 'message', role: 'user', toolName: undefined, toolCallId: undefined },
      { kind: 'tool_call', role: 'assistant', toolName: 'exec', toolCallId: 'call-1' },
      { kind: 'tool_result', role: 'tool', toolName: undefined, toolCallId: 'call-1' },
    ])
    expect(result.events.map((event) => event.index)).toEqual([0, 1, 2, 3, 4])
    expect(result.events.every((event) => event.sourceLocator.length > 0)).toBe(true)
    expect(result.sourceRevision).toMatchObject({
      kind: 'jsonl-watermark',
      changedDuringRun: false,
    })
  })

  it('Codex 区分真人消息、宿主注入、Skill 指令、内部任务与运行时事件', async () => {
    const sourcePath = writeJsonl('codex-origins', [
      {
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: 'You are Codex.' },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '# AGENTS.md instructions for /tmp/demo' },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '<skills_instructions>chrome-use</skills_instructions>' },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '[memory-manager:live-evidence-map] 内部索引任务' },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '<session_message>历史转发</session_message>' },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '请总结 chrome-use 联调踩坑' },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: '先检查登录态。' },
      },
      {
        type: 'response_item',
        payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: 'pwd' },
      },
    ])
    addSession('codex-origins', 'codex', sourcePath)

    const [result] = await readSessionEventSources(
      [{ id: 'codex-origins', agent: 'codex' }],
      { homeDir: home },
    )

    expect(result.events.map(({ origin, originEvidence }) => ({ origin, originEvidence }))).toEqual([
      { origin: 'developer_instruction', originEvidence: 'source-envelope' },
      { origin: 'host_context', originEvidence: 'explicit-marker' },
      { origin: 'skill_instruction', originEvidence: 'explicit-marker' },
      { origin: 'internal_job', originEvidence: 'explicit-marker' },
      { origin: 'historical_forward', originEvidence: 'explicit-marker' },
      { origin: 'human_user', originEvidence: 'source-envelope' },
      { origin: 'assistant_output', originEvidence: 'source-envelope' },
      { origin: 'tool_runtime', originEvidence: 'source-envelope' },
    ])
  })

  it('Codex 丢弃重复宿主遥测，并移除 reasoning 密文和 tool search 定义正文', async () => {
    const sourcePath = writeJsonl('codex-compact-metadata', [
      {
        type: 'event_msg',
        payload: { type: 'mcp_tool_call_end', output: 'duplicate-output'.repeat(10_000) },
      },
      {
        type: 'turn_context',
        payload: { developer_instructions: 'host-context'.repeat(10_000) },
      },
      {
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'reasoning-1',
          summary: [{ type: 'summary_text', text: '检查页面状态' }],
          encrypted_content: 'ciphertext'.repeat(10_000),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'tool_search_output',
          call_id: 'search-1',
          tools: [{ name: 'mcp__computer_use__computer', description: 'definition'.repeat(10_000) }],
        },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '保留这条真人消息' },
      },
    ])
    addSession('codex-compact-metadata', 'codex', sourcePath)

    const [result] = await readSessionEventSources(
      [{ id: 'codex-compact-metadata', agent: 'codex' }],
      { homeDir: home },
    )

    expect(result.events).toHaveLength(3)
    expect(result.events).toEqual([
      expect.objectContaining({
        kind: 'metadata',
        role: 'assistant',
        content: { type: 'reasoning', id: 'reasoning-1', summary: ['检查页面状态'] },
      }),
      expect.objectContaining({
        kind: 'metadata',
        content: { type: 'tool_search_output', callId: 'search-1' },
      }),
      expect.objectContaining({
        kind: 'message',
        role: 'user',
        origin: 'human_user',
        content: '保留这条真人消息',
      }),
    ])
    expect(JSON.stringify(result.events)).not.toContain('ciphertext')
    expect(JSON.stringify(result.events)).not.toContain('duplicate-output')
    expect(JSON.stringify(result.events)).not.toContain('definition')
  })

  it.each([
    ['claude', [
      {
        type: 'assistant',
        timestamp: '2026-08-09T00:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '开始' },
            { type: 'tool_use', id: 'tool-1', name: 'mcp__chrome__navigate', input: { url: 'x' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
        },
      },
    ]],
    ['cursor', [
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: '开始' },
            { type: 'tool_use', id: 'tool-1', name: 'mcp__chrome__navigate', input: { url: 'x' } },
          ],
        },
      },
      {
        role: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
        },
      },
    ]],
    ['pi', [
      { type: 'session', id: 'pi-events', cwd: '/tmp/demo' },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '开始' },
            { type: 'toolCall', id: 'tool-1', name: 'mcp__chrome__navigate', input: { url: 'x' } },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'tool',
          content: [{ type: 'toolResult', toolCallId: 'tool-1', content: 'ok' }],
        },
      },
    ]],
  ] as const)('%s 把内容块标准化为独立事件', async (agent, rows) => {
    const id = `${agent}-events`
    const sourcePath = writeJsonl(id, [...rows])
    addSession(id, agent, sourcePath)

    const [result] = await readSessionEventSources([{ id, agent }], { homeDir: home })

    expect(result.status).toBe('readable')
    expect(result.events.map((event) => event.kind)).toContain('tool_call')
    expect(result.events.map((event) => event.kind)).toContain('tool_result')
    expect(result.events.find((event) => event.kind === 'tool_call')).toMatchObject({
      toolName: 'mcp__chrome__navigate',
      toolCallId: 'tool-1',
    })
  })

  it('Copilot tool.execution 事件保留 call id 与结果', async () => {
    const sourcePath = path.join(home, 'copilot', 'session-state', 'copilot-events', 'events.jsonl')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, `${[
      { type: 'user.message', text: '打开浏览器' },
      {
        type: 'tool.execution_start',
        data: { id: 'tool-1', name: 'mcp__computer_use__computer', input: { action: 'click' } },
      },
      {
        type: 'tool.execution_complete',
        data: { id: 'tool-1', name: 'mcp__computer_use__computer', output: 'ok' },
      },
    ].map((row) => JSON.stringify(row)).join('\n')}\n`)
    addSession('copilot-events', 'copilot', sourcePath)

    const [result] = await readSessionEventSources(
      [{ id: 'copilot-events', agent: 'copilot' }],
      { homeDir: home },
    )

    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message', role: 'user', content: '打开浏览器' }),
      expect.objectContaining({ kind: 'tool_call', toolName: 'mcp__computer_use__computer' }),
      expect.objectContaining({ kind: 'tool_result', toolCallId: 'tool-1', content: 'ok' }),
    ]))
  })

  it('OpenCode SQLite 把 title、text 和 tool state 标准化并固定事务水位', async () => {
    const sourcePath = path.join(home, 'opencode.db')
    const source = new Database(sourcePath)
    source.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      );
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
    `)
    source.prepare('INSERT INTO session VALUES (?, ?)').run('open-events', 'Chrome 联调')
    source.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
      'message-1',
      'open-events',
      1,
      JSON.stringify({ role: 'assistant', time: { created: 1 } }),
    )
    source.prepare('INSERT INTO part VALUES (?, ?, ?)').run(
      'part-1',
      'message-1',
      JSON.stringify({
        type: 'tool',
        callID: 'call-open',
        tool: 'mcp__chrome__navigate',
        state: { input: { url: 'x' }, output: 'done' },
      }),
    )
    source.close()
    addSession('open-events', 'opencode', sourcePath)

    const [result] = await readSessionEventSources(
      [{ id: 'open-events', agent: 'opencode' }],
      { homeDir: home },
    )

    expect(result.events).toEqual([
      expect.objectContaining({ kind: 'metadata', content: { title: 'Chrome 联调' } }),
      expect.objectContaining({
        kind: 'tool_call',
        toolName: 'mcp__chrome__navigate',
        toolCallId: 'call-open',
        content: { url: 'x' },
      }),
      expect.objectContaining({ kind: 'tool_result', toolCallId: 'call-open', content: 'done' }),
    ])
    expect(result.sourceRevision).toMatchObject({
      kind: 'sqlite-transaction',
      changedDuringRun: false,
    })
  })

  it('把 source missing、invalid 和 empty 分别记为唯一终态', async () => {
    const invalid = path.join(home, 'invalid.jsonl')
    fs.writeFileSync(invalid, 'not-json\n')
    const empty = path.join(home, 'empty.jsonl')
    fs.writeFileSync(empty, '')
    addSession('missing', 'codex', path.join(home, 'missing.jsonl'))
    addSession('invalid', 'codex', invalid)
    addSession('empty', 'codex', empty)

    const results = await readSessionEventSources([
      { id: 'missing', agent: 'codex' },
      { id: 'invalid', agent: 'codex' },
      { id: 'empty', agent: 'codex' },
    ], { homeDir: home })

    expect(results.map(({ status, errorCode }) => ({ status, errorCode }))).toEqual([
      { status: 'unavailable', errorCode: 'SOURCE_NOT_FOUND' },
      { status: 'failed', errorCode: 'SOURCE_FORMAT_INVALID' },
      { status: 'empty', errorCode: 'SOURCE_EMPTY' },
    ])
  })

  it('JSONL 读取水位之后追加的事件不进入本轮，并披露 changedDuringRun', async () => {
    const sourcePath = writeJsonl('changing', [{ role: 'user', content: 'initial' }])
    addSession('changing', 'codex', sourcePath)

    const [result] = await readSessionEventSources(
      [{ id: 'changing', agent: 'codex' }],
      { homeDir: home },
      {
        afterJsonlSnapshot: () => {
          fs.appendFileSync(sourcePath, `${JSON.stringify({ role: 'user', content: 'later' })}\n`)
        },
      },
    )

    expect(result.events.map((event) => event.content)).toEqual(['initial'])
    expect(result.sourceRevision?.changedDuringRun).toBe(true)
  })
})
