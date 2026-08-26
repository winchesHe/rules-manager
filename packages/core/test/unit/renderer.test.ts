import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../../src/db'
import {
  renderGlobalRules,
  renderProjectRules,
  renderStyleRules,
} from '../../src/renderer'
import { resolveWorkspace } from '../../src/workspace'

describe('rules renderer', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-renderer-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
    initDatabase(home).close()
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function insertCandidate(options: {
    id: string
    scope: 'global' | 'project' | 'personal_style'
    ruleText: string
    confidence: 'high' | 'medium' | 'low'
    status?: 'accepted' | 'draft'
    projectSlug?: string
  }): void {
    const db = initDatabase(home)
    const now = '2026-07-27T00:00:00.000Z'
    db.prepare(`
      INSERT INTO rule_candidates (
        id, scope, project_slug, rule_text, confidence_level, status,
        evidence_json, source_sessions, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      options.id,
      options.scope,
      options.projectSlug ?? null,
      options.ruleText,
      options.confidence,
      options.status ?? 'accepted',
      '{}',
      '[]',
      now,
      now,
    )
    db.close()
  }

  it('没有 accepted 规则时返回空字符串', () => {
    insertCandidate({
      id: 'draft',
      scope: 'global',
      ruleText: 'Do not render',
      confidence: 'high',
      status: 'draft',
    })

    expect(renderGlobalRules(home)).toBe('')
    expect(renderStyleRules(home)).toBe('')
    expect(renderProjectRules('demo', home)).toBe('')
  })

  it('只渲染 accepted 规则并按 high、medium、low 排序', () => {
    insertCandidate({ id: 'low', scope: 'global', ruleText: 'Low rule', confidence: 'low' })
    insertCandidate({ id: 'high', scope: 'global', ruleText: 'High rule', confidence: 'high' })
    insertCandidate({ id: 'medium', scope: 'global', ruleText: 'Medium rule', confidence: 'medium' })
    insertCandidate({ id: 'ignored', scope: 'global', ruleText: 'Draft rule', confidence: 'high', status: 'draft' })

    const rendered = renderGlobalRules(home)
    expect(rendered).toContain('<!-- 此文件由 memory-manager 自动生成，手动修改会被覆盖 -->')
    expect(rendered).not.toContain('Draft rule')
    expect(rendered.indexOf('High rule')).toBeLessThan(rendered.indexOf('Medium rule'))
    expect(rendered.indexOf('Medium rule')).toBeLessThan(rendered.indexOf('Low rule'))
  })

  it('project 只包含指定 slug 的规则', () => {
    insertCandidate({ id: 'demo', scope: 'project', projectSlug: 'demo', ruleText: 'Demo rule', confidence: 'high' })
    insertCandidate({ id: 'other', scope: 'project', projectSlug: 'other', ruleText: 'Other rule', confidence: 'high' })
    insertCandidate({ id: 'global', scope: 'global', ruleText: 'Global rule', confidence: 'high' })

    const rendered = renderProjectRules('demo', home)
    expect(rendered).toContain('- Demo rule')
    expect(rendered).not.toContain('Other rule')
    expect(rendered).not.toContain('Global rule')
  })

  it('personal_style 只渲染个人风格规则', () => {
    insertCandidate({ id: 'style', scope: 'personal_style', ruleText: 'Be concise', confidence: 'high' })
    insertCandidate({ id: 'global', scope: 'global', ruleText: 'Run tests', confidence: 'high' })

    expect(renderStyleRules(home)).toContain('- Be concise')
    expect(renderStyleRules(home)).not.toContain('Run tests')
  })
})
