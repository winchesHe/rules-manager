import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import { listGenerationHistory } from '../main/generation-history'

describe('generation history', () => {
  let directory: string
  let dbPath: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-generation-history-'))
    dbPath = path.join(directory, 'memory.db')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE run_metadata (
        id TEXT PRIMARY KEY,
        run_type TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        details TEXT
      );
      CREATE TABLE rule_candidates (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        scope TEXT NOT NULL,
        project_slug TEXT,
        rule_text TEXT NOT NULL,
        confidence_level TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        source_sessions TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    db.close()
  })

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('按开始时间倒序恢复生成范围、Evidence 摘要和候选数量', () => {
    const db = new Database(dbPath)
    const insert = db.prepare(`
      INSERT INTO run_metadata (id, run_type, started_at, ended_at, status, details)
      VALUES (?, 'generate-rules', ?, ?, ?, ?)
    `)
    insert.run(
      'older',
      '2026-07-29T10:00:00.000Z',
      '2026-07-29T10:01:00.000Z',
      'completed',
      JSON.stringify({
        request: { mode: 'projects', projects: ['rules-manager'] },
        evidence: {
          projectCount: 1,
          totalSessions: 8,
          projects: [{
            slug: 'rules-manager',
            sessionIds: ['s1', 's2'],
            roundCount: 6,
            excerptCount: 12,
          }],
          createdAt: '2026-07-29T10:00:10.000Z',
        },
        candidateCount: 3,
      }),
    )
    db.prepare(`
      INSERT INTO rule_candidates (
        id, run_id, scope, project_slug, rule_text, confidence_level, status,
        evidence_json, source_sessions, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'candidate-1',
      'older',
      'global',
      null,
      'Always run tests.',
      'high',
      'accepted',
      JSON.stringify({ reasoning: 'Repeated correction.', evidence_refs: ['s1:1'] }),
      JSON.stringify(['s1']),
      '2026-07-29T10:00:30.000Z',
      '2026-07-29T10:00:30.000Z',
    )
    insert.run(
      'latest',
      '2026-07-30T10:00:00.000Z',
      '2026-07-30T10:02:00.000Z',
      'failed',
      JSON.stringify({
        request: { mode: 'changed7d', projects: [] },
        evidence: { projectCount: 5, totalSessions: 28 },
        failure: 'provider unavailable',
      }),
    )
    db.close()

    expect(listGenerationHistory(dbPath)).toEqual([
      {
        id: 'latest',
        startedAt: '2026-07-30T10:00:00.000Z',
        endedAt: '2026-07-30T10:02:00.000Z',
        status: 'failed',
        request: { mode: 'changed7d', projects: [] },
        evidence: { projectCount: 5, totalSessions: 28 },
        candidateCount: 0,
        candidates: [],
        failure: 'provider unavailable',
      },
      {
        id: 'older',
        startedAt: '2026-07-29T10:00:00.000Z',
        endedAt: '2026-07-29T10:01:00.000Z',
        status: 'completed',
        request: { mode: 'projects', projects: ['rules-manager'] },
        evidence: {
          projectCount: 1,
          totalSessions: 8,
          projects: [{
            slug: 'rules-manager',
            sessionIds: ['s1', 's2'],
            roundCount: 6,
            excerptCount: 12,
          }],
          createdAt: '2026-07-29T10:00:10.000Z',
        },
        candidateCount: 3,
        candidates: [{
          id: 'candidate-1',
          run_id: 'older',
          scope: 'global',
          project_slug: null,
          rule_text: 'Always run tests.',
          confidence_level: 'high',
          status: 'accepted',
          evidence_json: JSON.stringify({
            reasoning: 'Repeated correction.',
            evidence_refs: ['s1:1'],
          }),
          source_sessions: JSON.stringify(['s1']),
          created_at: '2026-07-29T10:00:30.000Z',
          updated_at: '2026-07-29T10:00:30.000Z',
        }],
      },
    ])
  })

  it('兼容旧生成记录缺少 details 字段', () => {
    const db = new Database(dbPath)
    db.prepare(`
      INSERT INTO run_metadata (id, run_type, started_at, ended_at, status, details)
      VALUES ('legacy', 'generate-rules', ?, ?, 'interrupted', NULL)
    `).run('2026-07-28T10:00:00.000Z', '2026-07-28T10:00:30.000Z')
    db.close()

    expect(listGenerationHistory(dbPath)).toEqual([
      {
        id: 'legacy',
        startedAt: '2026-07-28T10:00:00.000Z',
        endedAt: '2026-07-28T10:00:30.000Z',
        status: 'interrupted',
        request: { mode: 'recent', projects: [] },
        candidateCount: 0,
        candidates: [],
      },
    ])
  })
})
