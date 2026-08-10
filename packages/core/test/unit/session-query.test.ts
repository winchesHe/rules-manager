import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../../src/db'
import type { SessionEvent } from '../../src/session-events'
import {
  analyzeToolSignals,
  evaluateSessionPredicate,
  extractToolSignals,
  parseSessionQuery,
  runSessionQuery,
} from '../../src/session-query'
import type { AgentName, SessionStatus } from '../../src/types'
import { resolveWorkspace } from '../../src/workspace'

function event(
  index: number,
  input: Omit<SessionEvent, 'index' | 'sourceLocator' | 'origin' | 'originEvidence'>
    & Partial<Pick<SessionEvent, 'origin' | 'originEvidence'>>,
): SessionEvent {
  const origin = input.origin ?? (
    input.kind === 'tool_call' || input.kind === 'tool_result'
      ? 'tool_runtime'
      : input.role === 'assistant'
        ? 'assistant_output'
        : input.role === 'user'
          ? 'human_user'
          : input.role === 'system'
            ? 'developer_instruction'
            : 'unknown'
  )
  return {
    index,
    sourceLocator: `fixture:${index + 1}`,
    origin,
    originEvidence: input.originEvidence ?? 'source-envelope',
    ...input,
  }
}

describe('Session Query', () => {
  describe('query schema', () => {
    it('补齐关键词默认值并拒绝未知字段、冲突时间和过深谓词', () => {
      expect(parseSessionQuery({
        version: 1,
        where: { keyword: { terms: ['Chrome'] } },
      })).toMatchObject({
        where: { keyword: { terms: ['Chrome'], mode: 'any', caseSensitive: false } },
      })

      expect(parseSessionQuery({
        version: 2,
        where: { mentions: { terms: ['Chrome'] } },
      })).toMatchObject({
        version: 2,
        where: { mentions: { terms: ['Chrome'], mode: 'any', caseSensitive: false } },
      })
      expect(() => parseSessionQuery({ version: 3 })).toThrow()
      expect(() => parseSessionQuery({ version: 1, extra: true })).toThrow()
      expect(() => parseSessionQuery({
        version: 1,
        time: { lastDays: 7, since: '2026-08-01T00:00:00Z' },
      })).toThrow('lastDays 不能和 since/until 混用')

      let predicate: unknown = { keyword: { terms: ['x'] } }
      for (let depth = 0; depth < 9; depth++) predicate = { not: predicate }
      expect(() => parseSessionQuery({ version: 1, where: predicate })).toThrow(
        'where 递归深度不能超过 8',
      )
    })
  })

  describe('tool predicates', () => {
    const events: SessionEvent[] = [
      event(0, {
        kind: 'message',
        role: 'system',
        content: 'Available skills: computer-use and chrome-use',
      }),
      event(1, {
        kind: 'tool_call',
        role: 'assistant',
        toolName: 'exec',
        content: {
          code: 'const result = await tools.mcp__computer_use__computer({action:"click"})',
        },
      }),
      event(2, {
        kind: 'tool_call',
        role: 'assistant',
        toolName: 'mcp__chrome__navigate',
        content: { url: 'https://example.com' },
      }),
      event(3, {
        kind: 'tool_call',
        role: 'assistant',
        toolName: 'computer',
        content: { action: 'screenshot' },
      }),
    ]

    it('区分 direct、nested、capability-derived，且不读取 system 工具说明', () => {
      expect(extractToolSignals([events[0]])).toEqual([])
      expect(extractToolSignals(events)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          family: 'computer-use',
          toolName: 'mcp__computer_use__computer',
          provenance: 'nested-ast',
          eventIndex: 1,
        }),
        expect.objectContaining({
          family: 'chrome-use',
          toolName: 'mcp__chrome__navigate',
          provenance: 'direct',
          eventIndex: 2,
        }),
        expect.objectContaining({
          family: 'computer-use',
          toolName: 'computer',
          provenance: 'capability-derived',
          operation: 'screenshot',
        }),
      ]))
    })

    it('按 family、operation 和 provenance 组合过滤并返回 locator', () => {
      const nested = evaluateSessionPredicate({
        tool: { families: ['computer-use'], provenance: ['nested'] },
      }, events)
      expect(nested).toMatchObject({ matched: true })
      expect(nested.proofs).toEqual([
        expect.objectContaining({
          kind: 'tool',
          family: 'computer-use',
          provenance: 'nested',
          eventIndex: 1,
          sourceLocator: 'fixture:2',
        }),
      ])

      expect(evaluateSessionPredicate({
        tool: { families: ['computer-use'], operations: ['screenshot'] },
      }, events).matched).toBe(true)
      expect(evaluateSessionPredicate({
        tool: { families: ['chrome-use'], provenance: ['nested'] },
      }, events).matched).toBe(false)
    })

    it('只识别 AST 中真实调用，忽略 patch、字符串、注释和 fixture', () => {
      const falsePositive = event(4, {
        kind: 'tool_call',
        role: 'assistant',
        toolName: 'exec',
        content: `
          const patch = "await tools.mcp__computer_use__computer({action:'click'})"
          const fixture = { code: 'tools.mcp__chrome__navigate({url:"x"})' }
          // await tools.mcp__computer_use__computer({action:'screenshot'})
          await tools.apply_patch(patch)
        `,
      })

      expect(extractToolSignals([falsePositive]).filter((signal) => signal.family)).toEqual([])
      expect(evaluateSessionPredicate({
        usedTool: { families: ['computer-use', 'chrome-use'] },
      }, [falsePositive])).toMatchObject({ status: 'not_matched', matched: false })
    })

    it('识别当前插件通过 node_repl 暴露的 Computer Use 与 Chrome 运行时调用', () => {
      const runtimeCalls = event(6, {
        kind: 'tool_call',
        role: 'assistant',
        toolName: 'exec',
        content: `
          await tools.mcp__node_repl__js({code: \`await sky.click({app:"Electron", element_index:1})\`})
          await tools.mcp__node_repl__js({code: \`globalThis.chrome = await agent.browsers.get("chrome"); await chrome.documentation()\`})
          await tools.mcp__computer_use_legacy__get_app_state({app:"Electron"})
        `,
      })

      expect(extractToolSignals([runtimeCalls])).toEqual(expect.arrayContaining([
        expect.objectContaining({
          family: 'computer-use',
          toolName: '@oai/sky.click',
          operation: 'click',
          provenance: 'capability-derived',
        }),
        expect.objectContaining({
          family: 'chrome-use',
          toolName: 'browser-client.chrome.select',
          operation: 'select',
          provenance: 'capability-derived',
        }),
        expect.objectContaining({
          family: 'computer-use',
          toolName: 'mcp__computer_use_legacy__get_app_state',
          operation: 'get_app_state',
          provenance: 'nested-ast',
        }),
      ]))
      expect(evaluateSessionPredicate({
        usedTool: { families: ['computer-use'], operations: ['click'] },
      }, [runtimeCalls])).toMatchObject({ status: 'matched' })
      expect(evaluateSessionPredicate({
        usedTool: { families: ['chrome-use'], operations: ['select'] },
      }, [runtimeCalls])).toMatchObject({ status: 'matched' })
    })

    it('不解析普通字符串中的 Computer Use / Chrome 运行时代码', () => {
      const runtimeFixture = event(7, {
        kind: 'tool_call',
        role: 'assistant',
        toolName: 'exec',
        content: `
          const skyFixture = 'await sky.click({app:"Electron"})'
          const chromeFixture = 'await agent.browsers.get("chrome")'
          await tools.apply_patch(skyFixture + chromeFixture)
        `,
      })

      expect(extractToolSignals([runtimeFixture]).filter((signal) => signal.family)).toEqual([])
    })

    it('疑似嵌套调用但代码无法解析时返回 unknown，而不是 notMatched', () => {
      const malformed = event(5, {
        kind: 'tool_call',
        role: 'assistant',
        toolName: 'exec',
        content: 'await tools.mcp__computer_use__computer({',
      })

      expect(analyzeToolSignals([malformed]).unknowns).toHaveLength(1)
      expect(evaluateSessionPredicate({
        usedTool: { families: ['computer-use'] },
      }, [malformed])).toMatchObject({
        status: 'unknown',
        matched: false,
        unknownCode: 'QUERY_TOOL_PARSE_UNKNOWN',
      })

      const malformedChrome = event(6, {
        kind: 'tool_call',
        role: 'assistant',
        toolName: 'exec',
        content: 'await tools.mcp__node_repl__js({code: `await chrome.tabs.new({',
      })
      expect(evaluateSessionPredicate({
        usedTool: { families: ['chrome-use'] },
      }, [malformedChrome])).toMatchObject({
        status: 'unknown',
        matched: false,
        unknownCode: 'QUERY_TOOL_PARSE_UNKNOWN',
      })
    })
  })

  describe('keyword and boolean predicates', () => {
    const events: SessionEvent[] = [
      event(0, { kind: 'message', role: 'system', content: 'permission denied in tool catalog' }),
      event(1, { kind: 'message', role: 'user', content: 'Chrome 联调又失败了' }),
      event(2, { kind: 'message', role: 'assistant', content: '需要重新授权 permission denied' }),
      event(3, { kind: 'tool_result', role: 'tool', content: { error: 'timeout' } }),
      event(4, { kind: 'metadata', content: { title: 'Browser Extension' } }),
    ]

    it('按字段匹配 any/all，system 内容默认不参与', () => {
      expect(evaluateSessionPredicate({
        keyword: { terms: ['permission denied'], mode: 'any', caseSensitive: false },
      }, [events[0]]).matched).toBe(false)

      const matched = evaluateSessionPredicate({
        keyword: {
          terms: ['chrome', 'permission denied'],
          mode: 'all',
          fields: ['user', 'assistant'],
          caseSensitive: false,
        },
      }, events)
      expect(matched.matched).toBe(true)
      expect(matched.proofs).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'keyword', term: 'chrome', field: 'user', eventIndex: 1 }),
        expect.objectContaining({
          kind: 'keyword',
          term: 'permission denied',
          field: 'assistant',
          eventIndex: 2,
        }),
      ]))
      expect(matched.proofs.every((proof) => proof.contentHash?.match(/^[a-f0-9]{64}$/))).toBe(
        true,
      )
    })

    it('递归组合 all/any/not，并为否定命中提供谓词 hash', () => {
      const result = evaluateSessionPredicate({
        all: [
          { keyword: { terms: ['extension'], mode: 'any', caseSensitive: false, fields: ['title'] } },
          { not: { keyword: { terms: ['success'], mode: 'any', caseSensitive: false } } },
          {
            any: [
              { keyword: { terms: ['timeout'], mode: 'any', caseSensitive: false } },
              { keyword: { terms: ['not-found'], mode: 'any', caseSensitive: false } },
            ],
          },
        ],
      }, events)

      expect(result.matched).toBe(true)
      expect(result.proofs).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'keyword', field: 'title' }),
        expect.objectContaining({ kind: 'keyword', field: 'tool_result_output' }),
        expect.objectContaining({ kind: 'not', predicateHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      ]))
    })

    it('v2 mentions 默认只搜索真人与助手消息，排除 Host/Skill/Internal 注入', () => {
      const v2Events = [
        event(0, {
          kind: 'message', role: 'user', origin: 'host_context',
          content: '# AGENTS.md instructions for /repo\ncomputer-use 联调失败',
        }),
        event(1, {
          kind: 'message', role: 'user', origin: 'skill_instruction',
          content: '<skill>chrome-use 联调失败</skill>',
        }),
        event(2, {
          kind: 'message', role: 'user', origin: 'internal_job',
          content: '[memory-manager:live-evidence-map] computer-use 联调失败',
        }),
        event(3, {
          kind: 'message', role: 'user', origin: 'human_user',
          content: '请复盘 computer-use 联调失败',
        }),
      ]
      const matched = evaluateSessionPredicate({
        mentions: {
          terms: ['computer-use', '联调'],
          mode: 'all',
          fields: ['message'],
          caseSensitive: false,
        },
      }, v2Events)

      expect(matched.status).toBe('matched')
      expect(matched.proofs).toHaveLength(2)
      expect(matched.proofs.every((proof) => (
        proof.eventIndex === 3 && proof.origin === 'human_user'
      ))).toBe(true)
    })

    it('来源不明的关键词默认返回 unknown，只有显式允许 unknown origin 才命中', () => {
      const unknownOrigin = event(0, {
        kind: 'message',
        role: 'user',
        origin: 'unknown',
        originEvidence: 'legacy-inferred',
        content: 'computer-use 联调',
      })

      expect(evaluateSessionPredicate({
        mentions: { terms: ['computer-use'], mode: 'any', caseSensitive: false },
      }, [unknownOrigin])).toMatchObject({
        status: 'unknown',
        unknownCode: 'QUERY_ORIGIN_UNKNOWN',
      })
      expect(evaluateSessionPredicate({
        mentions: {
          terms: ['computer-use'],
          mode: 'any',
          origins: ['unknown'],
          caseSensitive: false,
        },
      }, [unknownOrigin])).toMatchObject({ status: 'matched' })
    })
  })
})

describe('runSessionQuery integration', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-run-session-query-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function addSession(input: {
    id: string
    agent?: AgentName
    updatedAt: string
    content?: string
    rows?: unknown[]
    status?: SessionStatus
  }): void {
    const sourcePath = path.join(home, `${input.id}.jsonl`)
    if (input.rows !== undefined) {
      fs.writeFileSync(sourcePath, `${input.rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    } else if (input.content !== undefined) {
      fs.writeFileSync(sourcePath, `${JSON.stringify({ role: 'user', content: input.content })}\n`)
    }
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'demo', 'hash', ?, ?, ?, ?)
    `).run(
      input.id,
      input.agent ?? 'codex',
      sourcePath,
      `/tmp/${input.id}.jsonl`,
      input.updatedAt,
      input.status ?? 'updated',
      input.updatedAt,
      input.updatedAt,
    )
    db.close()
  }

  it('时间候选全部进入 matched/notMatched/unknown，且 unknown 阻止完整选择结论', async () => {
    addSession({ id: 'matched', updatedAt: '2026-08-09T00:00:00.000Z', content: 'Chrome 调试失败' })
    addSession({ id: 'not-matched', updatedAt: '2026-08-08T00:00:00.000Z', content: '普通代码任务' })
    addSession({ id: 'unknown', updatedAt: '2026-08-07T00:00:00.000Z' })
    addSession({ id: 'old', updatedAt: '2026-07-01T00:00:00.000Z', content: 'Chrome old' })

    const result = await runSessionQuery({
      version: 1,
      time: { lastDays: 7 },
      where: { keyword: { terms: ['chrome'] } },
    }, {
      homeDir: home,
      now: new Date('2026-08-10T00:00:00.000Z'),
    })

    expect(result.coverage).toEqual({
      candidates: 3,
      inspected: 2,
      matched: 1,
      notMatched: 1,
      unknown: 1,
      unknownSource: 1,
      unknownOrigin: 0,
      unknownToolParse: 0,
      changedDuringRun: 0,
    })
    expect(result.outcomes.map(({ sessionId, selectionStatus }) => ({
      sessionId,
      selectionStatus,
    }))).toEqual([
      { sessionId: 'matched', selectionStatus: 'matched' },
      { sessionId: 'not-matched', selectionStatus: 'not_matched' },
      { sessionId: 'unknown', selectionStatus: 'unknown' },
    ])
    expect(result.matchedSources.map((source) => source.sessionId)).toEqual(['matched'])
  })

  it('无 where 的最近 7 天查询把所有可检查 Session 纳入全量选集', async () => {
    addSession({ id: 'first', updatedAt: '2026-08-09T00:00:00.000Z', content: 'first' })
    addSession({ id: 'second', updatedAt: '2026-08-08T00:00:00.000Z', content: 'second' })

    const result = await runSessionQuery({ version: 1, time: { lastDays: 7 } }, {
      homeDir: home,
      now: new Date('2026-08-10T00:00:00.000Z'),
    })

    expect(result.coverage).toMatchObject({
      candidates: 2,
      inspected: 2,
      matched: 2,
      notMatched: 0,
      unknown: 0,
    })
    expect(result.outcomes.every((outcome) => (
      outcome.selectionStatus === 'matched' && outcome.proofs[0]?.kind === 'all'
    ))).toBe(true)
  })

  it('验收查询只命中真实工具使用或可信联调提及，不把 patch/AGENTS/内部任务当证据', async () => {
    const updatedAt = '2026-08-09T00:00:00.000Z'
    addSession({
      id: 'actual-tool',
      updatedAt,
      rows: [
        { role: 'user', content: '继续页面联调' },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'call-1',
            name: 'exec',
            input: { code: 'await tools.mcp__computer_use__computer({action:"click"})' },
          },
        },
      ],
    })
    addSession({
      id: 'trusted-mention',
      updatedAt,
      content: '请总结 computer-use、chrome-use 联调时踩过的坑',
    })
    addSession({
      id: 'patch-only',
      updatedAt,
      rows: [{
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call-2',
          name: 'exec',
          input: {
            code: 'const patch = "await tools.mcp__computer_use__computer({action:\\"click\\"})"',
          },
        },
      }],
    })
    addSession({
      id: 'host-injection',
      updatedAt,
      rows: [{
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: '# AGENTS.md instructions for /repo\ncomputer-use chrome-use 联调',
        },
      }],
    })
    addSession({
      id: 'internal-job',
      updatedAt,
      rows: [
        { role: 'user', content: '# AGENTS.md instructions for /repo' },
        { role: 'user', content: '[memory-manager:live-evidence-map] computer-use chrome-use 联调' },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'call-internal',
            name: 'mcp__chrome__navigate',
            input: { url: 'https://example.com' },
          },
        },
      ],
    })

    const result = await runSessionQuery({
      version: 2,
      time: { lastDays: 30 },
      where: {
        all: [
          {
            any: [
              { usedTool: { families: ['computer-use', 'chrome-use'] } },
              { mentions: { terms: ['computer-use', 'chrome-use'], mode: 'any' } },
            ],
          },
          { mentions: { terms: ['联调'], mode: 'any' } },
        ],
      },
    }, {
      homeDir: home,
      now: new Date('2026-08-10T00:00:00.000Z'),
    })

    expect(result.outcomes.filter((outcome) => outcome.selectionStatus === 'matched').map(
      (outcome) => outcome.sessionId,
    ).sort()).toEqual(['actual-tool', 'trusted-mention'])
    expect(result.outcomes.find((outcome) => outcome.sessionId === 'actual-tool')?.proofs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'tool_usage',
        family: 'computer-use',
        provenance: 'nested-ast',
      }),
      expect.objectContaining({ kind: 'mention', term: '联调' }),
    ]))
    expect(result.outcomes.find((outcome) => outcome.sessionId === 'patch-only')).toMatchObject({
      selectionStatus: 'not_matched',
    })
    expect(result.outcomes.find((outcome) => outcome.sessionId === 'host-injection')).toMatchObject({
      selectionStatus: 'not_matched',
    })
    expect(result.outcomes.find((outcome) => outcome.sessionId === 'internal-job')).toMatchObject({
      selectionStatus: 'not_matched',
      proofs: [{ kind: 'excluded_internal' }],
    })
  })

  it('流式回调逐 Session 消费命中正文且不在 Query 结果中保留事件', async () => {
    addSession({ id: 'stream-first', updatedAt: '2026-08-09T00:00:00.000Z', content: 'first' })
    addSession({ id: 'stream-second', updatedAt: '2026-08-08T00:00:00.000Z', content: 'second' })
    const consumed: Array<{ id: string; events: number }> = []

    const result = await runSessionQuery({ version: 1, time: { lastDays: 7 } }, {
      homeDir: home,
      now: new Date('2026-08-10T00:00:00.000Z'),
      retainMatchedSources: false,
      onMatchedSource: (source, outcome) => {
        expect(outcome.selectionStatus).toBe('matched')
        consumed.push({ id: source.sessionId, events: source.eventCount })
      },
    })

    expect(consumed).toEqual([
      { id: 'stream-first', events: 1 },
      { id: 'stream-second', events: 1 },
    ])
    expect(result.coverage.matched).toBe(2)
    expect(result.matchedSources).toEqual([])
  })
})
