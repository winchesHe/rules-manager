import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildEvidenceBundle, extractEvidence, readSessionPreview } from '../../src/evidence'
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

  it('默认只取最新 30 条用户或 assistant 消息', () => {
    const messages = Array.from({ length: 35 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index}`,
      timestamp: `2026-07-27T00:${String(index).padStart(2, '0')}:00Z`,
    })).reverse()
    const bundle = buildEvidenceBundle('demo', [{ sessionId: 's1', agent: 'codex', messages }])

    expect(bundle.roundCount).toBe(30)
    expect(bundle.excerpts.some((excerpt) => excerpt.text.includes('message-0'))).toBe(false)
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
})
