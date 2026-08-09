import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { jest } from '@jest/globals'
import {
  buildEvidenceBundle,
  extractEvidence,
  readSessionEvidenceContext,
  readSessionPreview,
} from '../../src/evidence'
import { initDatabase } from '../../src/db'
import { resolveWorkspace } from '../../src/workspace'

describe('buildEvidenceBundle', () => {
  it('过滤工具参数和结果，只保留工具名与摘要', () => {
    const bundle = buildEvidenceBundle('demo', [{
      sessionId: 's1',
      agent: 'claude',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'password=secret' } },
          { type: 'tool_result', tool_name: 'Bash', content: 'raw secret output' },
        ],
      }],
    }], { full: true })

    expect(bundle.excerpts).toHaveLength(1)
    expect(bundle.excerpts[0].tools).toEqual([
      { tool: 'Bash', summary: '调用工具' },
      { tool: 'Bash', summary: '工具返回结果' },
    ])
    expect(JSON.stringify(bundle)).not.toContain('raw secret output')
    expect(JSON.stringify(bundle)).not.toContain('password=secret')
  })

  it('默认读取全部用户与 assistant 消息', () => {
    const messages = Array.from({ length: 35 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index}`,
      timestamp: `2026-07-27T00:${String(index).padStart(2, '0')}:00Z`,
    })).reverse()
    const bundle = buildEvidenceBundle('demo', [{ sessionId: 's1', agent: 'codex', messages }])

    expect(bundle.roundCount).toBe(35)
    expect(bundle.excerpts.some((excerpt) => excerpt.text.includes('message-0'))).toBe(true)
    expect(bundle.excerpts.some((excerpt) => excerpt.text.includes('message-34'))).toBe(true)
    expect(bundle.excerpts.length).toBeGreaterThan(0)
  })

  it('关键词规则优先于普通对话且清理 secret', () => {
    const bundle = buildEvidenceBundle('demo', [{
      sessionId: 's1',
      agent: 'codex',
      messages: [
        { role: 'user', content: '普通闲聊' },
        { role: 'user', content: '必须先跑测试，token=super-secret' },
      ],
    }], { full: true })

    expect(bundle.excerpts[0].text).toContain('必须先跑测试')
    expect(JSON.stringify(bundle)).not.toContain('super-secret')
  })

  it('同 slug 的跨 session 相同表述标注 frequency', () => {
    const bundle = buildEvidenceBundle('demo', [
      { sessionId: 's1', agent: 'claude', messages: [{ role: 'user', content: 'Always run npm test' }] },
      { sessionId: 's2', agent: 'codex', messages: [{ role: 'user', content: 'Always run npm test' }] },
    ], { full: true })

    expect(bundle.excerpts).toHaveLength(2)
    expect(bundle.excerpts.every((excerpt) => excerpt.frequency === 2)).toBe(true)
  })

  it('过滤平台注入指令并将其转为既有规则 Baseline', () => {
    const referencedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-existing-rules-'))
    const referencedPath = path.join(referencedDir, 'RTK.md')
    fs.writeFileSync(referencedPath, '所有 shell 命令前加 rtk 前缀。')
    try {
      const bundle = buildEvidenceBundle('demo', [{
        sessionId: 's1',
        agent: 'codex',
        messages: [
          {
            role: 'user',
            content: [
              '<recommended_plugins>',
              'Injected plugin catalog',
              '</recommended_plugins>',
              '# AGENTS.md instructions for /workspace/demo',
              '<INSTRUCTIONS>',
              'always respond in 中文。',
              `@${referencedPath}`,
              '</INSTRUCTIONS>',
              '<environment_context>',
              '<cwd>/workspace/demo</cwd>',
              '</environment_context>',
            ].join('\n'),
          },
          { role: 'user', content: '以后测试失败时先告诉我具体失败项。' },
          { role: 'assistant', content: '收到，以后测试失败时先告诉你具体失败项。' },
        ],
      }], { full: true })

      expect(bundle.excerpts).toHaveLength(2)
      expect(bundle.excerpts.map((excerpt) => excerpt.evidenceKind)).toEqual([
        'user_signal',
        'assistant_context',
      ])
      expect(bundle.excerpts[1].frequency).toBe(0)
      expect(JSON.stringify(bundle.excerpts)).not.toContain('always respond in 中文')
      expect(bundle.existingRules).toEqual(expect.arrayContaining([
        expect.stringContaining('always respond in 中文'),
        expect.stringContaining('所有 shell 命令前加 rtk 前缀'),
      ]))
    } finally {
      fs.rmSync(referencedDir, { recursive: true, force: true })
    }
  })

  it('Assistant 复述不参与 frequency，只有真实用户表述构成跨 session 信号', () => {
    const bundle = buildEvidenceBundle('demo', [
      {
        sessionId: 's1',
        agent: 'claude',
        messages: [
          { role: 'user', content: '必须先运行测试' },
          { role: 'assistant', content: '必须先运行测试' },
        ],
      },
      {
        sessionId: 's2',
        agent: 'codex',
        messages: [{ role: 'assistant', content: '必须先运行测试' }],
      },
    ], { full: true })

    const userExcerpt = bundle.excerpts.find((excerpt) => excerpt.role === 'user')
    const assistantExcerpts = bundle.excerpts.filter((excerpt) => excerpt.role === 'assistant')
    expect(userExcerpt?.frequency).toBe(1)
    expect(assistantExcerpts.every((excerpt) => excerpt.frequency === 0)).toBe(true)
  })

  it('排除 Rules Generation 自己创建的 Provider Session，避免 Evidence 自我回灌', () => {
    const bundle = buildEvidenceBundle('demo', [
      {
        sessionId: 'internal-generation',
        agent: 'claude',
        messages: [
          {
            role: 'user',
            content: [
              '根据 evidence 提取可复用的 agent 规则候选。',
              JSON.stringify({ excerpts: [{ text: 'huge nested evidence' }] }),
            ].join('\n'),
          },
          { role: 'assistant', content: 'generated rule output' },
        ],
      },
      {
        sessionId: 'real-conversation',
        agent: 'claude',
        messages: [{ role: 'user', content: '必须先运行测试' }],
      },
    ])

    expect(bundle.sourceSessions).toEqual(['real-conversation'])
    expect(bundle.excerpts).toHaveLength(1)
    expect(bundle.excerpts[0].text).toBe('必须先运行测试')
    expect(JSON.stringify(bundle)).not.toContain('huge nested evidence')
    expect(JSON.stringify(bundle)).not.toContain('generated rule output')
  })
})

describe('extractEvidence session 路由', () => {
  it('从 workspace session 的 JSONL 原文提取 evidence', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-evidence-'))
    const workspace = resolveWorkspace(home)
    fs.mkdirSync(workspace.workspaceDir, { recursive: true })
    const sourcePath = path.join(home, 'session.jsonl')
    fs.writeFileSync(sourcePath, `${JSON.stringify({ type: 'user', message: { role: 'user', content: '不许泄露 API_KEY=secret-value' } })}\n`)
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('s1', 'claude', sourcePath, '/tmp/link', 'demo', 'hash', '2026-07-27', 'new', '2026-07-27', '2026-07-27')
    db.close()

    try {
      const bundles = await extractEvidence({ homeDir: home, projectSlug: 'demo', full: true })
      expect(bundles).toHaveLength(1)
      expect(bundles[0].excerpts.length).toBeGreaterThan(0)
      expect(JSON.stringify(bundles)).not.toContain('secret-value')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('识别 Copilot event 与 Codex 独立 function_call', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-evidence-routes-'))
    const workspace = resolveWorkspace(home)
    fs.mkdirSync(workspace.workspaceDir, { recursive: true })
    const copilotPath = path.join(home, 'copilot/events.jsonl')
    const codexPath = path.join(home, 'codex.jsonl')
    fs.mkdirSync(path.dirname(copilotPath), { recursive: true })
    fs.writeFileSync(copilotPath, `${JSON.stringify({ type: 'user.message', text: '必须保留这个偏好' })}\n`)
    fs.writeFileSync(codexPath, `${JSON.stringify({ payload: { type: 'function_call', name: 'shell', arguments: 'password=secret' } })}\n`)
    const db = initDatabase(home)
    const insert = db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run('copilot-1', 'copilot', copilotPath, '/tmp/copilot-link', 'demo', 'h1', '2026-07-27', 'new', '2026-07-27', '2026-07-27')
    insert.run('codex-1', 'codex', codexPath, '/tmp/codex-link', 'demo', 'h2', '2026-07-27', 'new', '2026-07-27', '2026-07-27')
    db.close()

    try {
      const [bundle] = await extractEvidence({ homeDir: home, projectSlug: 'demo', full: true })
      expect(bundle.excerpts.some((excerpt) => excerpt.text === '必须保留这个偏好')).toBe(true)
      expect(bundle.excerpts.some((excerpt) => excerpt.tools.some((tool) => tool.tool === 'shell'))).toBe(true)
      expect(JSON.stringify(bundle)).not.toContain('password=secret')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('Reader 失败由兼容层用稳定错误码呈现，并继续提取其他 Session', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-evidence-reader-failure-'))
    const workspace = resolveWorkspace(home)
    fs.mkdirSync(workspace.workspaceDir, { recursive: true })
    const invalidPath = path.join(home, 'invalid.jsonl')
    const validPath = path.join(home, 'valid.jsonl')
    fs.writeFileSync(invalidPath, 'not-json\n')
    fs.writeFileSync(validPath, `${JSON.stringify({
      role: 'user',
      content: '必须继续处理后续 Session',
    })}\n`)
    const db = initDatabase(home)
    const insert = db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, 'claude', ?, ?, 'demo', ?, '2026-08-09', 'updated', '2026-08-09', '2026-08-09')
    `)
    insert.run('invalid', invalidPath, '/tmp/invalid', 'invalid-hash')
    insert.run('valid', validPath, '/tmp/valid', 'valid-hash')
    db.close()
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const [bundle] = await extractEvidence({ homeDir: home, projectSlug: 'demo', full: true })

      expect(bundle.sourceSessions).toEqual(['valid'])
      expect(bundle.excerpts.map((excerpt) => excerpt.text)).toContain('必须继续处理后续 Session')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('[SOURCE_FORMAT_INVALID]'))
    } finally {
      error.mockRestore()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('指定 sessionIds 时只提取目标 sessions', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-evidence-session-scope-'))
    const workspace = resolveWorkspace(home)
    fs.mkdirSync(workspace.workspaceDir, { recursive: true })
    const firstPath = path.join(home, 'first.jsonl')
    const secondPath = path.join(home, 'second.jsonl')
    fs.writeFileSync(firstPath, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'first rule' } })}\n`)
    fs.writeFileSync(secondPath, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'second rule' } })}\n`)
    const db = initDatabase(home)
    const insert = db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, 'claude', ?, ?, 'demo', ?, '2026-07-29', 'unchanged', '2026-07-29', '2026-07-29')
    `)
    insert.run('s1', firstPath, '/tmp/first-link', 'h1')
    insert.run('s2', secondPath, '/tmp/second-link', 'h2')
    db.close()

    try {
      const bundles = await extractEvidence({
        homeDir: home,
        sessionIds: ['s2'],
        full: true,
      })
      expect(bundles).toHaveLength(1)
      expect(bundles[0].sourceSessions).toEqual(['s2'])
      expect(JSON.stringify(bundles)).toContain('second rule')
      expect(JSON.stringify(bundles)).not.toContain('first rule')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('updatedSince 按 session 自身 updated_at 选择最近对话且排除 missing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-evidence-updated-since-'))
    const workspace = resolveWorkspace(home)
    fs.mkdirSync(workspace.workspaceDir, { recursive: true })
    const db = initDatabase(home)
    const insert = db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, 'claude', ?, ?, 'demo', ?, ?, ?, '2026-07-01', '2026-07-30')
    `)
    for (const [id, updatedAt, status] of [
      ['old', '2026-07-22T23:59:59.999Z', 'unchanged'],
      ['boundary', '2026-07-23T00:00:00.000Z', 'unchanged'],
      ['recent', '2026-07-29T12:00:00.000Z', 'updated'],
      ['missing', '2026-07-30T00:00:00.000Z', 'missing'],
    ]) {
      const sourcePath = path.join(home, `${id}.jsonl`)
      fs.writeFileSync(sourcePath, `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `rule-${id}` },
      })}\n`)
      insert.run(id, sourcePath, `/tmp/${id}`, `hash-${id}`, updatedAt, status)
    }
    db.close()

    try {
      const bundles = await extractEvidence({
        homeDir: home,
        updatedSince: '2026-07-23T00:00:00.000Z',
      })
      expect(bundles).toHaveLength(1)
      expect(bundles[0].sourceSessions).toEqual(['boundary', 'recent'])
      expect(JSON.stringify(bundles)).not.toContain('rule-old')
      expect(JSON.stringify(bundles)).not.toContain('rule-missing')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('指定多个 projectSlugs 时一次性冻结多个项目的 evidence', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-evidence-projects-scope-'))
    const workspace = resolveWorkspace(home)
    fs.mkdirSync(workspace.workspaceDir, { recursive: true })
    const db = initDatabase(home)
    const insert = db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, 'claude', ?, ?, ?, ?, '2026-07-29', 'unchanged', '2026-07-29', '2026-07-29')
    `)
    for (const [id, slug] of [['s1', 'alpha'], ['s2', 'beta'], ['s3', 'gamma']]) {
      const sourcePath = path.join(home, `${id}.jsonl`)
      fs.writeFileSync(sourcePath, `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `rule for ${slug}` },
      })}\n`)
      insert.run(id, sourcePath, `/tmp/${id}`, slug, `hash-${id}`)
    }
    db.close()

    try {
      const bundles = await extractEvidence({
        homeDir: home,
        projectSlugs: ['alpha', 'gamma'],
        full: true,
      })
      expect(bundles.map((bundle) => bundle.projectSlug)).toEqual(['alpha', 'gamma'])
      expect(bundles.flatMap((bundle) => bundle.sourceSessions)).toEqual(['s1', 's3'])
      expect(JSON.stringify(bundles)).not.toContain('rule for beta')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('readSessionPreview', () => {
  it('按需返回脱敏消息与工具摘要，不暴露工具参数和结果', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-session-preview-'))
    const workspace = resolveWorkspace(home)
    fs.mkdirSync(workspace.workspaceDir, { recursive: true })
    const sourcePath = path.join(home, 'preview.jsonl')
    fs.writeFileSync(
      sourcePath,
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'token=super-secret 请修复列表' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '已经完成' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell',
            arguments: 'password=do-not-show',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            output: 'raw tool output',
          },
        }),
      ].join('\n'),
    )
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'preview-session',
      'codex',
      sourcePath,
      '/tmp/preview-link',
      'demo',
      'hash',
      '2026-07-29',
      'updated',
      '2026-07-29',
      '2026-07-29',
    )
    db.close()

    try {
      const preview = await readSessionPreview('preview-session', home)
      expect(preview.agent).toBe('codex')
      expect(preview.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'assistant',
      ])
      expect(JSON.stringify(preview)).toContain('token=[REDACTED]')
      expect(JSON.stringify(preview)).toContain('"tool":"shell"')
      expect(JSON.stringify(preview)).not.toContain('super-secret')
      expect(JSON.stringify(preview)).not.toContain('do-not-show')
      expect(JSON.stringify(preview)).not.toContain('raw tool output')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('按 Evidence 原始消息索引返回命中前后的脱敏窗口', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-evidence-context-'))
    const workspace = resolveWorkspace(home)
    fs.mkdirSync(workspace.workspaceDir, { recursive: true })
    const sourcePath = path.join(home, 'context.jsonl')
    fs.writeFileSync(
      sourcePath,
      [
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: '先看列表' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: 'token=super-secret 开发时必须只启动一个 Electron 实例',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: '我会修复启动逻辑' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', name: 'shell', arguments: 'password=hidden' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', output: 'raw tool output' },
        }),
      ].join('\n'),
    )
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'context-session', 'codex', sourcePath, '/tmp/context-link', 'demo', 'hash',
      '2026-07-31', 'updated', '2026-07-31', '2026-07-31',
    )
    db.close()

    try {
      const context = await readSessionEvidenceContext(
        'context-session',
        1,
        { before: 1, after: 2 },
        home,
      )
      expect(context.messages.map((message) => message.messageIndex)).toEqual([0, 1, 2, 3])
      expect(context.messages.map((message) => message.matched)).toEqual([false, true, false, false])
      expect(JSON.stringify(context)).toContain('token=[REDACTED]')
      expect(JSON.stringify(context)).toContain('"tool":"shell"')
      expect(JSON.stringify(context)).not.toContain('super-secret')
      expect(JSON.stringify(context)).not.toContain('hidden')
      expect(JSON.stringify(context)).not.toContain('raw tool output')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('OpenCode SQLite 引用使用与生成时一致的消息索引', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-opencode-context-'))
    const workspace = resolveWorkspace(home)
    fs.mkdirSync(workspace.workspaceDir, { recursive: true })
    const sourcePath = path.join(home, 'opencode.db')
    const sourceDb = new Database(sourcePath)
    sourceDb.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `)
    const insertMessage = sourceDb.prepare(
      'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
    )
    const insertPart = sourceDb.prepare(
      'INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)',
    )
    insertMessage.run('m1', 'opencode-session', 1, JSON.stringify({ role: 'user', time: { created: 1 } }))
    insertPart.run('p1', 'm1', JSON.stringify({
      text: '# AGENTS.md instructions for /tmp/demo\n\n<INSTRUCTIONS>\n必须保留命中上下文\n</INSTRUCTIONS>',
    }))
    insertMessage.run('m2', 'opencode-session', 2, JSON.stringify({ role: 'user', time: { created: 2 } }))
    insertPart.run('p2', 'm2', JSON.stringify({ text: '必须保留命中上下文' }))
    insertMessage.run('m3', 'opencode-session', 3, JSON.stringify({ role: 'assistant', time: { created: 3 } }))
    insertPart.run('p3', 'm3', JSON.stringify({ text: '收到' }))
    sourceDb.close()

    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'opencode-session', 'opencode', sourcePath, '/tmp/opencode-link', 'demo', 'hash',
      '2026-07-31', 'updated', '2026-07-31', '2026-07-31',
    )
    db.close()

    try {
      const baseline = await readSessionEvidenceContext('opencode-session', 0, {}, home)
      expect(baseline.eligibility).toBe('existing_rule_baseline')
      const context = await readSessionEvidenceContext('opencode-session', 1, {}, home)
      expect(context.agent).toBe('opencode')
      expect(context.eligibility).toBe('eligible')
      expect(context.messages.find((message) => message.matched)?.text)
        .toBe('必须保留命中上下文')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
