import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publishGlobalRulesToAgents } from '../../src/agent-instruction-publish'
import { initDatabase } from '../../src/db'
import { readGlobalInstructionSource } from '../../src/global-instructions'
import { resolveWorkspace } from '../../src/workspace'

describe('publish global rules to Agent instructions', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-agent-publish-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
    initDatabase(home).close()
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function insertAccepted(
    id: string,
    scope: 'global' | 'project',
    text: string,
  ): void {
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO rule_candidates (
        id, scope, project_slug, rule_text, confidence_level, status,
        evidence_json, source_sessions, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'high', 'accepted', '{}', '[]', ?, ?)
    `).run(
      id,
      scope,
      scope === 'project' ? 'rules-manager' : null,
      text,
      '2026-07-30T00:00:00.000Z',
      '2026-07-30T00:00:00.000Z',
    )
    db.close()
  }

  it('只把 accepted global rules 写入所选 Agent 的 managed block', () => {
    insertAccepted('g1', 'global', 'Always run focused tests')
    insertAccepted('p1', 'project', 'Project-only rule')
    const claudePath = path.join(home, '.claude/CLAUDE.md')
    fs.mkdirSync(path.dirname(claudePath), { recursive: true })
    fs.writeFileSync(claudePath, '# Personal instructions\n')
    const claude = readGlobalInstructionSource('claude', { homeDir: home, env: {} })
    const codex = readGlobalInstructionSource('codex', { homeDir: home, env: {} })

    const result = publishGlobalRulesToAgents([
      { agent: 'claude', expectedRevision: claude.revision },
      { agent: 'codex', expectedRevision: codex.revision },
    ], home)

    expect(result).toMatchObject({
      ruleCount: 1,
      results: [
        { agent: 'claude', status: 'published' },
        { agent: 'codex', status: 'published' },
      ],
    })
    const claudeContent = fs.readFileSync(claudePath, 'utf8')
    const codexContent = fs.readFileSync(path.join(home, '.codex/AGENTS.md'), 'utf8')
    expect(claudeContent).toContain('# Personal instructions')
    expect(claudeContent).toContain('Always run focused tests')
    expect(claudeContent).not.toContain('Project-only rule')
    expect(codexContent).toContain('memory-manager:global-rules:start')
  })

  it('重复 publish 替换 managed block 而不重复追加', () => {
    insertAccepted('g1', 'global', 'Always run focused tests')
    const opened = readGlobalInstructionSource('pi', { homeDir: home, env: {} })
    publishGlobalRulesToAgents([
      { agent: 'pi', expectedRevision: opened.revision },
    ], home)
    const afterFirst = readGlobalInstructionSource('pi', { homeDir: home, env: {} })

    const result = publishGlobalRulesToAgents([
      { agent: 'pi', expectedRevision: afterFirst.revision },
    ], home)

    expect(result.results[0].status).toBe('unchanged')
    expect(afterFirst.content.match(/memory-manager:global-rules:start/g)).toHaveLength(1)
  })

  it('单个 Agent 冲突不会阻止其他 Agent 发布', () => {
    insertAccepted('g1', 'global', 'Always run focused tests')
    const claude = readGlobalInstructionSource('claude', { homeDir: home, env: {} })
    const codex = readGlobalInstructionSource('codex', { homeDir: home, env: {} })
    const claudePath = path.join(home, '.claude/CLAUDE.md')
    fs.mkdirSync(path.dirname(claudePath), { recursive: true })
    fs.writeFileSync(claudePath, '# External edit\n')

    const result = publishGlobalRulesToAgents([
      { agent: 'claude', expectedRevision: claude.revision },
      { agent: 'codex', expectedRevision: codex.revision },
    ], home)

    expect(result.results).toEqual([
      expect.objectContaining({ agent: 'claude', status: 'failed' }),
      expect.objectContaining({ agent: 'codex', status: 'published' }),
    ])
    expect(fs.readFileSync(claudePath, 'utf8')).toBe('# External edit\n')
  })
})
