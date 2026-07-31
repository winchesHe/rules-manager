import Database from 'better-sqlite3'
import { resolveWorkspace } from './workspace.js'

export interface RuleCandidateRow {
  id: string
  run_id: string | null
  scope: string
  project_slug: string | null
  rule_text: string
  confidence_level: string
  status: string
  evidence_json: string
  source_sessions: string
  created_at: string
  updated_at: string
}

function openDatabase(homeDir?: string, readonly = true): Database.Database {
  return new Database(resolveWorkspace(homeDir).dbPath, { readonly, fileMustExist: true })
}

export function listRuleCandidates(homeDir?: string, status = 'draft'): RuleCandidateRow[] {
  const db = openDatabase(homeDir)
  try {
    return db.prepare(`
      SELECT * FROM rule_candidates
      WHERE status = ?
      ORDER BY created_at, id
    `).all(status) as RuleCandidateRow[]
  } finally {
    db.close()
  }
}

export function getRuleCandidate(id: string, homeDir?: string): RuleCandidateRow {
  const db = openDatabase(homeDir)
  try {
    const row = db.prepare('SELECT * FROM rule_candidates WHERE id = ?').get(id) as RuleCandidateRow | undefined
    if (!row) throw new Error(`rule candidate 不存在：${id}`)
    return row
  } finally {
    db.close()
  }
}

export function updateRuleCandidateStatus(
  id: string,
  status: 'accepted' | 'rejected',
  homeDir?: string,
): RuleCandidateRow {
  return updateRuleCandidatesStatus([id], status, homeDir)[0]
}

export function updateRuleCandidatesStatus(
  ids: string[],
  status: 'accepted' | 'rejected',
  homeDir?: string,
): RuleCandidateRow[] {
  const normalizedIds = [...new Set(ids.map((id) => id.trim()))]
  if (normalizedIds.length === 0 || normalizedIds.some((id) => !id)) {
    throw new Error('至少需要一个 rule candidate')
  }
  if (normalizedIds.length > 500) {
    throw new Error('单次最多更新 500 个 rule candidate')
  }
  const db = openDatabase(homeDir, false)
  try {
    const select = db.prepare('SELECT * FROM rule_candidates WHERE id = ?')
    const update = db.prepare(`
      UPDATE rule_candidates SET status = ?, updated_at = ? WHERE id = ?
    `)
    return db.transaction(() => {
      const candidates = normalizedIds.map((id) => {
        const row = select.get(id) as RuleCandidateRow | undefined
        if (!row) throw new Error(`rule candidate 不存在：${id}`)
        return row
      })
      const updatedAt = new Date().toISOString()
      for (const candidate of candidates) {
        update.run(status, updatedAt, candidate.id)
      }
      return normalizedIds.map((id) => select.get(id) as RuleCandidateRow)
    })()
  } finally {
    db.close()
  }
}

export function updateRuleCandidateText(
  id: string,
  ruleText: string,
  homeDir?: string,
): RuleCandidateRow {
  const normalized = ruleText.trim()
  if (!normalized) throw new Error('rule candidate 正文不能为空')
  if (Buffer.byteLength(normalized, 'utf8') > 16 * 1024) {
    throw new Error('rule candidate 正文超过 16 KiB')
  }
  const db = openDatabase(homeDir, false)
  try {
    const current = db.prepare(
      'SELECT status FROM rule_candidates WHERE id = ?',
    ).get(id) as { status: string } | undefined
    if (!current) throw new Error(`rule candidate 不存在：${id}`)
    if (current.status !== 'draft') {
      throw new Error('只有 draft candidate 可以编辑')
    }
    db.prepare(`
      UPDATE rule_candidates
      SET rule_text = ?, updated_at = ?
      WHERE id = ? AND status = 'draft'
    `).run(normalized, new Date().toISOString(), id)
    return db.prepare('SELECT * FROM rule_candidates WHERE id = ?').get(id) as RuleCandidateRow
  } finally {
    db.close()
  }
}
