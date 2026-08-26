import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runRulesAccept,
  runRulesExplain,
  runRulesReject,
} from '../../src/commands/rules-review'
import { initDatabase } from '../../src/db'
import {
  updateRuleCandidatesStatus,
  updateRuleCandidateText,
} from '../../src/rule-candidates'
import { resolveWorkspace } from '../../src/workspace'

describe('rules review actions', () => {
  let home: string
  let output: string[]
  let originalLog: typeof console.log

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-rules-review-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO rule_candidates (
        id, scope, project_slug, rule_text, confidence_level, evidence_json,
        source_sessions, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'candidate-1', 'project', 'demo', 'Always run tests', 'high',
      JSON.stringify({
        reasoning: 'Explicit requirement',
        evidence_refs: ['s1:0'],
        bundle: { excerpts: [{ locator: { sessionId: 's1', messageIndex: 0 }, text: 'Always run tests' }] },
      }),
      JSON.stringify(['s1']), '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z',
    )
    db.close()
    output = []
    originalLog = console.log
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '))
  })

  afterEach(() => {
    console.log = originalLog
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('accept 把 status 更新为 accepted', () => {
    runRulesAccept('candidate-1', { homeDir: home })
    const db = initDatabase(home)
    expect(db.prepare('SELECT status FROM rule_candidates WHERE id = ?').get('candidate-1')).toEqual({ status: 'accepted' })
    db.close()
  })

  it('reject 把 status 更新为 rejected', () => {
    runRulesReject('candidate-1', { homeDir: home })
    const db = initDatabase(home)
    expect(db.prepare('SELECT status FROM rule_candidates WHERE id = ?').get('candidate-1')).toEqual({ status: 'rejected' })
    db.close()
  })

  it('explain 输出规则、置信度、reasoning 和 evidence 回源片段', () => {
    runRulesExplain('candidate-1', { homeDir: home })
    const explained = JSON.parse(output.join('\n')) as Record<string, unknown>
    expect(explained.ruleText).toBe('Always run tests')
    expect(explained.confidenceLevel).toBe('high')
    expect(explained.reasoning).toBe('Explicit requirement')
    expect(JSON.stringify(explained.evidence)).toContain('s1')
    expect(JSON.stringify(explained.evidence)).toContain('Always run tests')
  })

  it('draft candidate 可编辑规则正文，但 accepted candidate 不可再改', () => {
    expect(
      updateRuleCandidateText('candidate-1', 'Always run focused tests', home),
    ).toMatchObject({
      id: 'candidate-1',
      rule_text: 'Always run focused tests',
      status: 'draft',
    })

    runRulesAccept('candidate-1', { homeDir: home })
    expect(() =>
      updateRuleCandidateText('candidate-1', 'Change after accept', home),
    ).toThrow('只有 draft candidate 可以编辑')
  })

  it('批量状态更新保持事务原子性', () => {
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO rule_candidates (
        id, scope, project_slug, rule_text, confidence_level, evidence_json,
        source_sessions, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'candidate-2', 'project', 'demo', 'Run typecheck', 'high', '{}', '[]',
      '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z',
    )
    db.close()

    expect(updateRuleCandidatesStatus(
      ['candidate-1', 'candidate-2'],
      'accepted',
      home,
    ).map((candidate) => candidate.status)).toEqual(['accepted', 'accepted'])

    const resetDb = initDatabase(home)
    resetDb.prepare("UPDATE rule_candidates SET status = 'draft'").run()
    resetDb.close()
    expect(() => updateRuleCandidatesStatus(
      ['candidate-1', 'missing-candidate'],
      'rejected',
      home,
    )).toThrow('rule candidate 不存在：missing-candidate')

    const verifyDb = initDatabase(home)
    expect(verifyDb.prepare(
      'SELECT status FROM rule_candidates WHERE id = ?',
    ).get('candidate-1')).toEqual({ status: 'draft' })
    verifyDb.close()
  })
})
