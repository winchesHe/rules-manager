import Database from 'better-sqlite3'
import { getDbPath, isDatabaseReady } from './db.js'
import { classifyHints } from './classifier.js'
import type { ProjectHint, ProjectHintKind, ProjectHintSource, AgentName } from './types.js'

export interface ProjectsHomeOptions {
  homeDir?: string
}

export interface ProjectListItem {
  projectKey: string
  confidence: number
  sessionCount: number
  agents: string[]
}

export interface AssignResult {
  previousKey: string | null
}

export interface MergeResult {
  sessionsMoved: number
}

export interface ReclassifyResult {
  total: number
  changed: number
}

interface ProjectRow {
  project_key: string
  confidence: number
  session_count: number
  agents: string
}

interface SessionProjectRow {
  session_id: string
  project_key: string
}

interface HintRow {
  session_id: string
  kind: string
  value: string
  confidence: number
  agent: string
  source: string
  locator: string | null
}

/**
 * 从 session_projects 重算 projects 表：
 * - 没有任何 session 的 project_key 直接删除
 * - 其余 project 的 confidence = MAX(session_projects.confidence)
 *
 * 这是 R2 的权威重算逻辑；scan / assign / merge / reclassify 都调用它。
 */
export function rebuildProjectsSummary(db: Database.Database, now: string): void {
  db.prepare(
    `DELETE FROM projects
       WHERE project_key NOT IN (SELECT DISTINCT project_key FROM session_projects)`,
  ).run()

  const groups = db
    .prepare(
      `SELECT project_key, MAX(confidence) AS max_conf
         FROM session_projects GROUP BY project_key`,
    )
    .all() as Array<{ project_key: string; max_conf: number }>

  const upsert = db.prepare(`
    INSERT INTO projects (project_key, hints, confidence, updated_at)
    VALUES (?, '', ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET
      confidence = excluded.confidence,
      updated_at = excluded.updated_at
  `)
  for (const g of groups) {
    upsert.run(g.project_key, g.max_conf, now)
  }
}

export function listProjects(opts: ProjectsHomeOptions = {}): ProjectListItem[] {
  if (!isDatabaseReady(opts.homeDir)) return []
  const db = new Database(getDbPath(opts.homeDir), { readonly: true })
  try {
    const rows = db
      .prepare(
        `SELECT
           p.project_key                                   AS project_key,
           p.confidence                                    AS confidence,
           COUNT(sp.session_id)                            AS session_count,
           IFNULL(GROUP_CONCAT(DISTINCT s.agent), '')      AS agents
         FROM projects p
         LEFT JOIN session_projects sp ON sp.project_key = p.project_key
         LEFT JOIN sessions         s  ON s.id           = sp.session_id
         GROUP BY p.project_key
         ORDER BY session_count DESC, p.project_key ASC`,
      )
      .all() as ProjectRow[]
    return rows.map((r) => ({
      projectKey: r.project_key,
      confidence: r.confidence,
      sessionCount: r.session_count,
      agents: r.agents ? r.agents.split(',').filter(Boolean).sort() : [],
    }))
  } finally {
    db.close()
  }
}

/**
 * 把指定 session 强制归到目标项目（人工修正路径，confidence=1.0）。
 * 返回旧 project_key（可能为 null/旧值）。
 */
export function assignSession(
  sessionId: string,
  projectKey: string,
  opts: ProjectsHomeOptions = {},
): AssignResult {
  if (!sessionId) throw new Error('session-id required')
  if (!projectKey) throw new Error('project-key required')
  if (!isDatabaseReady(opts.homeDir)) {
    throw new Error('workspace not initialized; run `memory-manager init`')
  }
  const db = new Database(getDbPath(opts.homeDir))
  try {
    const session = db
      .prepare('SELECT id, project_key FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; project_key: string | null } | undefined
    if (!session) throw new Error(`session not found: ${sessionId}`)

    const previousKey = session.project_key
    const now = new Date().toISOString()

    const tx = db.transaction(() => {
      db.prepare('UPDATE sessions SET project_key = ? WHERE id = ?').run(projectKey, sessionId)
      db.prepare(`
        INSERT INTO session_projects (session_id, project_key, confidence, decided_at)
        VALUES (?, ?, 1.0, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          project_key = excluded.project_key,
          confidence  = excluded.confidence,
          decided_at  = excluded.decided_at
      `).run(sessionId, projectKey, now)
      rebuildProjectsSummary(db, now)
    })
    tx()

    return { previousKey }
  } finally {
    db.close()
  }
}

/**
 * 把 from 项目下所有 session / hint 转移到 to 项目。
 * - from == to → no-op，返回 0
 * - from 不存在（无 session 引用）→ 抛错
 * - to 可以不存在，会随 session 转移自动创建
 */
export function mergeProjects(
  from: string,
  to: string,
  opts: ProjectsHomeOptions = {},
): MergeResult {
  if (!from) throw new Error('from project-key required')
  if (!to) throw new Error('to project-key required')
  if (from === to) return { sessionsMoved: 0 }
  if (!isDatabaseReady(opts.homeDir)) {
    throw new Error('workspace not initialized; run `memory-manager init`')
  }
  const db = new Database(getDbPath(opts.homeDir))
  try {
    const cnt = (
      db.prepare('SELECT COUNT(*) AS c FROM session_projects WHERE project_key = ?').get(from) as {
        c: number
      }
    ).c
    if (cnt === 0) throw new Error(`no sessions belong to project: ${from}`)

    const now = new Date().toISOString()
    const tx = db.transaction(() => {
      db.prepare('UPDATE sessions SET project_key = ? WHERE project_key = ?').run(to, from)
      db.prepare('UPDATE session_projects SET project_key = ? WHERE project_key = ?').run(to, from)
      db.prepare('UPDATE project_hints SET project_key = ? WHERE project_key = ?').run(to, from)
      rebuildProjectsSummary(db, now)
    })
    tx()
    return { sessionsMoved: cnt }
  } finally {
    db.close()
  }
}

/**
 * 重新跑 classifier 到所有 session，基于已有的 project_hints 表。
 * 不重新调用 adapter.extractProjectHints；适合策略改进时全量重算。
 *
 * 注：error session（hints 为空，被 R1 写过 unknown）会重新分类为 unknown，无变化。
 *
 * full 参数当前与默认行为相同；预留给未来"忽略人工 assign 标记"的语义。
 */
export function reclassifyAll(
  opts: ProjectsHomeOptions & { full?: boolean } = {},
): ReclassifyResult {
  if (!isDatabaseReady(opts.homeDir)) {
    throw new Error('workspace not initialized; run `memory-manager init`')
  }
  const db = new Database(getDbPath(opts.homeDir))
  try {
    const now = new Date().toISOString()
    const sessions = db
      .prepare('SELECT id, project_key FROM sessions')
      .all() as Array<{ id: string; project_key: string | null }>

    let changed = 0

    const updateSession = db.prepare('UPDATE sessions SET project_key = ? WHERE id = ?')
    const upsertSP = db.prepare(`
      INSERT INTO session_projects (session_id, project_key, confidence, decided_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        project_key = excluded.project_key,
        confidence  = excluded.confidence,
        decided_at  = excluded.decided_at
    `)

    const tx = db.transaction(() => {
      for (const s of sessions) {
        const hintRows = db
          .prepare(
            `SELECT session_id, kind, value, confidence, agent, source, locator
               FROM project_hints WHERE session_id = ?`,
          )
          .all(s.id) as HintRow[]

        const hints: ProjectHint[] = hintRows.map((h) => ({
          kind: h.kind as ProjectHintKind,
          value: h.value,
          confidence: h.confidence,
          agent: h.agent as AgentName,
          source: h.source as ProjectHintSource,
          locator: h.locator ?? undefined,
        }))

        const c = classifyHints(hints)
        updateSession.run(c.projectKey, s.id)
        upsertSP.run(s.id, c.projectKey, c.confidence, now)
        if (s.project_key !== c.projectKey) changed++
      }
      rebuildProjectsSummary(db, now)
    })
    tx()

    return { total: sessions.length, changed }
  } finally {
    db.close()
  }
}
