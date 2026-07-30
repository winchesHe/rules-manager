import { EventEmitter } from 'node:events'
import { jest } from '@jest/globals'

const queryMock = jest.fn()
const spawnMock = jest.fn()

jest.unstable_mockModule('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}))
jest.unstable_mockModule('node:child_process', () => ({
  spawn: spawnMock,
}))

const { candidateRulesSchema, getStructuredResponse } = await import('../../src/llm')

function response(result: string, structuredOutput?: unknown): AsyncIterable<unknown> {
  return (async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      result,
      ...(structuredOutput === undefined ? {} : { structured_output: structuredOutput }),
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  })()
}

function codexProcess(lines: unknown[]) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: ReturnType<typeof jest.fn> }
    stderr: EventEmitter & { setEncoding: ReturnType<typeof jest.fn> }
    stdin: { end: ReturnType<typeof jest.fn> }
    kill: ReturnType<typeof jest.fn>
  }
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn() })
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn() })
  child.stdin = { end: jest.fn() }
  child.kill = jest.fn(() => true)
  queueMicrotask(() => {
    child.stdout.emit('data', `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    child.emit('close', 0)
  })
  return child
}

describe('getStructuredResponse', () => {
  beforeEach(() => {
    queryMock.mockReset()
    spawnMock.mockReset()
  })

  it('Claude 使用只读多回合与原生 JSON Schema，并校验 structured_output', async () => {
    const structured = [{
      scope: 'project',
      project_slug: 'demo',
      rule_text: 'Always run tests',
      confidence_level: 'high',
      reasoning: 'Repeated requirement',
      evidence_refs: ['s1:0'],
    }]
    queryMock.mockReturnValue(response('structured response', structured))

    const value = await getStructuredResponse(
      'evidence',
      candidateRulesSchema,
      'claude',
      'sonnet-test',
      'max',
      {
        fastMode: true,
        cwd: '/tmp/evidence-project',
        maxTurns: 12,
        tools: ['Read', 'Grep', 'Glob'],
      },
    )

    expect(value).toHaveLength(1)
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(queryMock.mock.calls[0][0]).toMatchObject({
      options: {
        maxTurns: 12,
        includePartialMessages: true,
        model: 'sonnet-test',
        effort: 'max',
        settings: { fastMode: true },
        cwd: '/tmp/evidence-project',
        tools: ['Read', 'Grep', 'Glob'],
        allowedTools: ['Read', 'Grep', 'Glob'],
        permissionMode: 'dontAsk',
        outputFormat: {
          type: 'json_schema',
          schema: expect.any(Object),
        },
      },
    })
    expect((queryMock.mock.calls[0][0] as { prompt: string }).prompt).toBe('evidence')
    const options = (queryMock.mock.calls[0][0] as {
      options: { outputFormat: { schema: Record<string, unknown> } }
    }).options
    expect(options.outputFormat.schema).not.toHaveProperty('$schema')
  })

  it('Fast Mode 关闭时仍显式覆盖 Claude session settings', async () => {
    queryMock.mockReturnValue(response('[]'))

    await getStructuredResponse(
      'evidence',
      candidateRulesSchema,
      'claude',
      undefined,
      'xhigh',
      { fastMode: false },
    )

    expect(queryMock.mock.calls[0][0]).toMatchObject({
      options: {
        maxTurns: 1,
        includePartialMessages: true,
        effort: 'xhigh',
        settings: { fastMode: false },
      },
    })
  })

  it.each([
    [true, 'priority'],
    [false, 'default'],
  ])('Codex Fast Mode %s 映射为 service_tier=%s', async (fastMode, serviceTier) => {
    const child = codexProcess([{
      type: 'item.completed',
      item: { type: 'agent_message', text: '[]' },
    }])
    spawnMock.mockReturnValue(child)

    await getStructuredResponse(
      'evidence',
      candidateRulesSchema,
      'codex',
      'gpt-test',
      'high',
      {
        fastMode,
        cwd: '/tmp/evidence-project',
        outputSchemaPath: '/tmp/evidence-project/schema.json',
      },
    )

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0][1]).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-C',
      '/tmp/evidence-project',
      '--output-schema',
      '/tmp/evidence-project/schema.json',
      '-m',
      'gpt-test',
      '-c',
      'model_reasoning_effort="high"',
      '-c',
      `service_tier=${JSON.stringify(serviceTier)}`,
      '-',
    ])
    expect(child.stdin.end).toHaveBeenCalledWith('evidence')
  })

  it('结构化输出损坏时立即失败，不携带完整 Evidence 原样重试', async () => {
    queryMock.mockReturnValue(response('not json'))

    await expect(
      getStructuredResponse('private evidence body', candidateRulesSchema, 'claude'),
    ).rejects.toThrow('JSON 解析失败')
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('Prompt too long 属于确定性失败，不原样重试', async () => {
    queryMock.mockReturnValue((async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['Prompt is too long'],
      }
    })())

    await expect(
      getStructuredResponse('read manifest.json', candidateRulesSchema, 'claude'),
    ).rejects.toThrow('Prompt is too long')
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('瞬时 Provider 错误有限重试并保留原始短 Prompt', async () => {
    queryMock
      .mockImplementationOnce(() => {
        throw new Error('temporary provider unavailable')
      })
      .mockReturnValueOnce(response('[]', []))
    const events: unknown[] = []

    await expect(getStructuredResponse(
      'read manifest.json',
      candidateRulesSchema,
      'claude',
      undefined,
      undefined,
      { maxRetries: 1, onEvent: (event) => events.push(event) },
    )).resolves.toEqual([])

    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(queryMock.mock.calls.map(
      (call) => (call[0] as { prompt: string }).prompt,
    )).toEqual([
      'read manifest.json',
      'read manifest.json',
    ])
    expect(events).toContainEqual({
      type: 'retry',
      message: 'temporary provider unavailable',
      attempt: 1,
    })
  })

  it('Claude 把 partial text delta 归一化为 assistant_delta', async () => {
    queryMock.mockReturnValue((async function* () {
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'streamed ' },
        },
      }
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'reply' },
        },
      }
      yield { type: 'result', subtype: 'success', result: '[]' }
    })())
    const events: unknown[] = []

    await getStructuredResponse(
      'evidence',
      candidateRulesSchema,
      'claude',
      undefined,
      undefined,
      { onEvent: (event) => events.push(event) },
    )

    expect(events).toEqual([
      { type: 'assistant_delta', text: 'streamed ' },
      { type: 'assistant_delta', text: 'reply' },
    ])
  })

  it('Claude 未提供 partial event 时仍把最终回复展示到输出流', async () => {
    queryMock.mockReturnValue(response('[]'))
    const events: unknown[] = []

    await getStructuredResponse(
      'evidence',
      candidateRulesSchema,
      'claude',
      undefined,
      undefined,
      { onEvent: (event) => events.push(event) },
    )

    expect(events).toEqual([{ type: 'assistant_delta', text: '[]' }])
  })

  it('Claude 把 thinking 与 tool use 归一化为可见 Activity 摘要', async () => {
    queryMock.mockReturnValue((async function* () {
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
      }
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: '先检查项目约束，' },
        },
      }
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: '再分析会话证据。' },
        },
      }
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_stop',
          index: 0,
        },
      }
      yield {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-read-1',
            name: 'Read',
            input: {
              file_path: '/repo/AGENTS.md',
              content: 'must never be exposed',
            },
          }],
        },
      }
      yield { type: 'result', subtype: 'success', result: '[]' }
    })())
    const events: unknown[] = []

    await getStructuredResponse(
      'evidence',
      candidateRulesSchema,
      'claude',
      undefined,
      undefined,
      { onEvent: (event) => events.push(event) },
    )

    expect(events).toContainEqual({
      type: 'activity',
      activity: {
        id: expect.stringMatching(/^claude-\d+-thinking-0$/),
        kind: 'thinking',
        label: 'Thinking',
        status: 'running',
      },
    })
    expect(events).toContainEqual({
      type: 'activity',
      activity: {
        id: expect.stringMatching(/^claude-\d+-thinking-0$/),
        kind: 'thinking',
        label: 'Thinking',
        status: 'completed',
        detail: '先检查项目约束，再分析会话证据。',
      },
    })
    expect(events).toContainEqual({
      type: 'activity',
      activity: {
        id: 'tool-read-1',
        kind: 'read',
        label: 'Read',
        detail: '/repo/AGENTS.md',
      },
    })
    expect(JSON.stringify(events)).not.toContain('must never be exposed')
  })

  it('Codex 逐行解析 JSONL delta，并用 completed message 作为最终输出', async () => {
    const child = codexProcess([
      {
        type: 'item.updated',
        item: {
          type: 'agent_message',
          delta: { text: '[' },
        },
      },
      {
        type: 'item.updated',
        item: {
          type: 'agent_message',
          delta: { text: ']' },
        },
      },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: '[]' },
      },
    ])
    spawnMock.mockReturnValue(child)
    const events: unknown[] = []

    await expect(getStructuredResponse(
      'evidence',
      candidateRulesSchema,
      'codex',
      undefined,
      undefined,
      { onEvent: (event) => events.push(event) },
    )).resolves.toEqual([])

    expect(events).toEqual([
      { type: 'assistant_delta', text: '[' },
      { type: 'assistant_delta', text: ']' },
    ])
  })

  it('Codex 只有 completed message 时仍把最终回复展示到输出流', async () => {
    const child = codexProcess([{
      type: 'item.completed',
      item: { type: 'agent_message', text: '[]' },
    }])
    spawnMock.mockReturnValue(child)
    const events: unknown[] = []

    await getStructuredResponse(
      'evidence',
      candidateRulesSchema,
      'codex',
      undefined,
      undefined,
      { onEvent: (event) => events.push(event) },
    )

    expect(events).toEqual([{ type: 'assistant_delta', text: '[]' }])
  })

  it('Codex 把 reasoning、搜索命令和 web search 逐行归一化为 Activity', async () => {
    const child = codexProcess([
      {
        type: 'item.started',
        item: { id: 'reason-1', type: 'reasoning', text: 'private chain of thought' },
      },
      {
        type: 'item.completed',
        item: {
          id: 'reason-1',
          type: 'reasoning',
          text: 'Checked the project constraints.',
        },
      },
      {
        type: 'item.started',
        item: {
          id: 'command-1',
          type: 'command_execution',
          command: 'rtk rg -n "ChatView" packages/app',
          aggregated_output: 'private tool output',
        },
      },
      {
        type: 'item.started',
        item: {
          id: 'search-1',
          type: 'web_search',
          query: 'Codex JSONL events',
          result: 'private search result',
        },
      },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: '[]' },
      },
    ])
    spawnMock.mockReturnValue(child)
    const events: unknown[] = []

    await getStructuredResponse(
      'evidence',
      candidateRulesSchema,
      'codex',
      undefined,
      undefined,
      { onEvent: (event) => events.push(event) },
    )

    expect(events).toEqual([
      {
        type: 'activity',
        activity: {
          id: 'reason-1',
          kind: 'thinking',
          label: 'Thinking',
          status: 'running',
        },
      },
      {
        type: 'activity',
        activity: {
          id: 'reason-1',
          kind: 'thinking',
          label: 'Thinking',
          status: 'completed',
          detail: 'Checked the project constraints.',
        },
      },
      {
        type: 'activity',
        activity: {
          id: 'command-1',
          kind: 'search',
          label: 'Search',
          detail: 'rtk rg -n "ChatView" packages/app',
          status: 'running',
        },
      },
      {
        type: 'activity',
        activity: {
          id: 'search-1',
          kind: 'search',
          label: 'Search',
          detail: 'Codex JSONL events',
          status: 'running',
        },
      },
      { type: 'assistant_delta', text: '[]' },
    ])
    expect(JSON.stringify(events)).not.toContain('private chain of thought')
  })
})
