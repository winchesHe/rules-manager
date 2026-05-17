import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type {
  AgentAdapter,
  DiscoveredSession,
  ProjectHint,
  ScanOptions,
  ScanSummary,
  SessionStatus,
} from './types.js'
import { ALL_ADAPTERS, getAdapters } from './adapters/index.js'
import { classify } from './classifier.js'
import { initDatabase } from './db.js'
import { linkSession, removeLink } from './fs-writer.js'
import { resolveWorkspace } from './workspace.js'

// determineScanState 比对所需的最小列契约
interface ScanCompareRow {
  id: string
  updated_at: string
  content_hash: string
}

// scanner 内 SELECT 拿到的完整行
interface ExistingSessionRow extends ScanCompareRow {
  slug: string
}

interface ScanErrorEntry {
  id?: string
  agent: string
  stage: 'discover' | 'parse' | 'hints' | 'classify' | 'fs' | 'db'
  message: string
}

export function determineScanState(
  discovered: DiscoveredSession,
  existing: ScanCompareRow | undefined,
): 'new' | 'updated' | 'unchanged' {
  if (!existing) return 'new'
  if (
    existing.updated_at !== discovered.updatedAt ||
    existing.content_hash !== discovered.contentHash
  ) {
    return 'updated'
  }
  return 'unchanged'
}

function logErr(
  agent: string,
  stage: ScanErrorEntry['stage'],
  detail: string,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[scan] ${agent} ${stage} failed at ${detail}: ${message}`)
  return message
}

export async function runScan(opts: ScanOptions): Promise<ScanSummary> {
  const { workspaceDir } = resolveWorkspace(opts.homeDir)
  const db = initDatabase(opts.homeDir)
  const now = new Date().toISOString()
  const runId = crypto.randomUUID()

  db.prepare(
    `INSERT INTO run_metadata (id, run_type, started_at, status) VALUES (?, 'scan', ?, 'running')`,
  ).run(runId, now)

  const useAllAdapters = opts.all || opts.full
  const adapters: AgentAdapter[] = useAllAdapters
    ? ALL_ADAPTERS
    : getAdapters(opts.agents ?? [])

  // 默认 source 根：<workspaceDir>/sources/<agent>/（用户软链 ~/.claude 等）
  const sourceBase = opts.source
    ? path.resolve(opts.source)
    : path.join(workspaceDir, 'sources')

  const summary: ScanSummary = {
    total: 0,
    new: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    errors: 0,
  }
  const errorLog: ScanErrorEntry[] = []

  const getSession = db.prepare(
    'SELECT id, slug, updated_at, content_hash FROM sessions WHERE id = ?',
  )
  const insertSession = db.prepare(`
    INSERT INTO sessions
      (id, agent, source_path, workspace_link, slug, content_hash, updated_at,
       status, first_seen_at, last_seen_at, classified_at)
    VALUES
      (@id, @agent, @source_path, @workspace_link, @slug, @content_hash, @updated_at,
       @status, @first_seen_at, @last_seen_at, @classified_at)
  `)
  const updateSession = db.prepare(`
    UPDATE sessions SET
      source_path    = @source_path,
      workspace_link = @workspace_link,
      slug           = @slug,
      content_hash   = @content_hash,
      updated_at     = @updated_at,
      status         = @status,
      last_seen_at   = @last_seen_at,
      classified_at  = @classified_at
    WHERE id = @id
  `)
  const markMissingStmt = db.prepare(
    "UPDATE sessions SET status = 'missing', last_seen_at = ? WHERE id = ?",
  )

  const scannedAgents = new Set<string>(adapters.map((a) => a.name))
  const discoveredIds = new Set<string>()

  for (const adapter of adapters) {
    const agentSourceDir = path.join(sourceBase, adapter.name)
    if (!fs.existsSync(agentSourceDir)) continue

    let sessions: DiscoveredSession[]
    try {
      sessions = await adapter.discover(agentSourceDir)
    } catch (err) {
      summary.errors++
      errorLog.push({
        agent: adapter.name,
        stage: 'discover',
        message: logErr(adapter.name, 'discover', agentSourceDir, err),
      })
      continue
    }

    for (const session of sessions) {
      discoveredIds.add(session.id)
      summary.total++

      // 抽 hints → 分类 → 建 symlink → 写库
      let hints: ProjectHint[] = []
      try {
        hints = await adapter.extractProjectHints(session)
      } catch (err) {
        // 抽 hints 失败不致命，降级落 default
        errorLog.push({
          id: session.id,
          agent: adapter.name,
          stage: 'hints',
          message: logErr(adapter.name, 'hints', session.id, err),
        })
      }
      const slug = classify(hints)

      let workspaceLink: string
      try {
        workspaceLink = linkSession(workspaceDir, slug, session.id, session.sourcePath)
      } catch (err) {
        summary.errors++
        errorLog.push({
          id: session.id,
          agent: adapter.name,
          stage: 'fs',
          message: logErr(adapter.name, 'fs', session.id, err),
        })
        continue
      }

      const existing = getSession.get(session.id) as ExistingSessionRow | undefined
      const state: SessionStatus = determineScanState(session, existing)

      try {
        if (!existing) {
          insertSession.run({
            id: session.id,
            agent: session.agent,
            source_path: session.sourcePath,
            workspace_link: workspaceLink,
            slug,
            content_hash: session.contentHash,
            updated_at: session.updatedAt,
            status: state,
            first_seen_at: now,
            last_seen_at: now,
            classified_at: now,
          })
          summary.new++
        } else {
          // 已存在 → 检查 slug 是否变化（classifier 可能给出不同 slug）
          if (existing.slug !== slug) {
            // 旧 slug 的 link 要移除（避免残留）
            try {
              removeLink(workspaceDir, existing.slug, session.id)
            } catch {
              // fs 已 reconcile 失败仅记日志，DB 仍按新 slug 写
            }
          }
          updateSession.run({
            id: session.id,
            source_path: session.sourcePath,
            workspace_link: workspaceLink,
            slug,
            content_hash: session.contentHash,
            updated_at: session.updatedAt,
            status: state,
            last_seen_at: now,
            classified_at: now,
          })
          if (state === 'updated') summary.updated++
          else summary.unchanged++
        }
      } catch (err) {
        summary.errors++
        errorLog.push({
          id: session.id,
          agent: adapter.name,
          stage: 'db',
          message: logErr(adapter.name, 'db', session.id, err),
        })
      }
    }
  }

  // missing 处理：本轮扫的 agent 范围内、DB 有但本轮未发现 → status='missing' + 删 FS link
  const allRows = db
    .prepare('SELECT id, agent, slug, status FROM sessions')
    .all() as Array<{ id: string; agent: string; slug: string; status: string }>

  for (const row of allRows) {
    if (
      scannedAgents.has(row.agent) &&
      !discoveredIds.has(row.id) &&
      row.status !== 'missing'
    ) {
      markMissingStmt.run(now, row.id)
      try {
        removeLink(workspaceDir, row.slug, row.id)
      } catch {
        // FS 已不一致就跳过，DB 是真理
      }
      summary.missing++
    }
  }

  const finalStatus = summary.errors > 0 ? 'partial' : 'success'
  db.prepare(
    `UPDATE run_metadata SET ended_at = ?, status = ?, details = ? WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    finalStatus,
    JSON.stringify({ summary, errors: errorLog }),
    runId,
  )

  db.close()
  return summary
}
