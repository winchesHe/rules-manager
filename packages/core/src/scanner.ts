import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type {
  AgentAdapter,
  DiscoveredSession,
  ProjectHint,
  ScanOptions,
  ScanProgress,
  ScanSummary,
  SessionStatus,
} from './types.js'
import { ALL_ADAPTERS, getAdapters } from './adapters/index.js'
import { classify } from './classifier.js'
import { initDatabase } from './db.js'
import { linkSession, removeLink } from './fs-writer.js'
import { resolveWorkspace } from './workspace.js'
import { isRunCancelledError, throwIfAborted } from './abort.js'
import { collectScannedSessionExclusionKeys, sessionExclusionKey } from './session-exclusions.js'

// determineScanState 比对所需的最小列契约
interface ScanCompareRow {
  id: string
  updated_at: string
  content_hash: string
  status?: SessionStatus
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
  if (existing.status === 'missing') return 'updated'
  if (
    existing.updated_at !== discovered.updatedAt ||
    existing.content_hash !== discovered.contentHash
  ) {
    return 'updated'
  }
  return 'unchanged'
}

function defaultAgentSourceDir(agent: AgentAdapter['name'], homeDir?: string): string {
  const home = homeDir ?? os.homedir()
  if (!homeDir && agent === 'claude' && process.env.CLAUDE_CONFIG_DIR) {
    return path.resolve(process.env.CLAUDE_CONFIG_DIR)
  }
  if (!homeDir && agent === 'codex' && process.env.CODEX_HOME) {
    return path.resolve(process.env.CODEX_HOME)
  }
  if (!homeDir && agent === 'gemini' && process.env.GEMINI_CLI_HOME) {
    return path.join(path.resolve(process.env.GEMINI_CLI_HOME), '.gemini')
  }
  if (!homeDir && agent === 'grok' && process.env.GROK_HOME) {
    return path.resolve(process.env.GROK_HOME)
  }
  if (agent === 'opencode') {
    const dataHome = !homeDir && process.env.XDG_DATA_HOME
      ? path.resolve(process.env.XDG_DATA_HOME)
      : path.join(home, '.local', 'share')
    return path.join(dataHome, 'opencode')
  }
  if (agent === 'pi') {
    if (!homeDir && process.env.PI_CODING_AGENT_SESSION_DIR) {
      return path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR)
    }
    if (!homeDir && process.env.PI_CODING_AGENT_DIR) {
      return path.resolve(process.env.PI_CODING_AGENT_DIR)
    }
    return path.join(home, '.pi', 'agent')
  }
  if (agent === 'grok') return path.join(home, '.grok')
  return path.join(home, `.${agent}`)
}

export function resolveAgentSourceDir(
  adapter: AgentAdapter,
  opts: ScanOptions,
  workspaceDir: string,
): string {
  if (opts.source) return path.join(path.resolve(opts.source), adapter.name)
  const configured = path.join(workspaceDir, 'sources', adapter.name)
  if (fs.existsSync(configured)) return configured
  return defaultAgentSourceDir(adapter.name, opts.homeDir)
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

async function reportProgress(opts: ScanOptions, progress: ScanProgress): Promise<void> {
  await opts.onProgress?.(progress)
  throwIfAborted(opts.signal)
}

export async function runScan(opts: ScanOptions): Promise<ScanSummary> {
  if (
    opts.sinceDays !== undefined &&
    (!Number.isInteger(opts.sinceDays) || opts.sinceDays <= 0)
  ) {
    throw new Error('scan sinceDays must be a positive integer')
  }

  const { workspaceDir } = resolveWorkspace(opts.homeDir)
  const db = initDatabase(opts.homeDir)
  const startedAt = new Date()
  const now = startedAt.toISOString()
  const cutoff =
    opts.sinceDays === undefined
      ? undefined
      : startedAt.getTime() - opts.sinceDays * 24 * 60 * 60 * 1000
  const runId = opts.runId ?? crypto.randomUUID()

  db.prepare(
    `INSERT INTO run_metadata (id, run_type, started_at, status) VALUES (?, 'scan', ?, 'running')`,
  ).run(runId, now)

  const useAllAdapters = opts.all || opts.full
  const adapters: AgentAdapter[] = useAllAdapters
    ? ALL_ADAPTERS
    : getAdapters(opts.agents ?? [])

  const summary: ScanSummary = {
    total: 0,
    new: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    errors: 0,
    changes: {
      new: [],
      updated: [],
      missing: [],
    },
  }
  const errorLog: ScanErrorEntry[] = []

  try {
    throwIfAborted(opts.signal)
    const getSession = db.prepare(
    'SELECT id, slug, updated_at, content_hash, status FROM sessions WHERE id = ?',
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

    const scannedAgents = new Set<string>()
    const discoveredIds = new Set<string>()
    const excludedSessionKeys = collectScannedSessionExclusionKeys(opts.homeDir)

    for (const adapter of adapters) {
      throwIfAborted(opts.signal)
    const agentSourceDir = resolveAgentSourceDir(adapter, opts, workspaceDir)
    await reportProgress(opts, { agent: adapter.name, phase: 'discovering' })
    if (!fs.existsSync(agentSourceDir)) {
      await reportProgress(opts, { agent: adapter.name, phase: 'skipped' })
      continue
    }

    let sessions: DiscoveredSession[]
    try {
      const discovered = await adapter.discover(agentSourceDir)
      sessions = (
        cutoff === undefined
          ? discovered
          : discovered.filter((session) => {
              const updatedAt = Date.parse(session.updatedAt)
              return Number.isNaN(updatedAt) || updatedAt >= cutoff
            })
      ).filter((session) => !excludedSessionKeys.has(sessionExclusionKey(session)))
    } catch (err) {
      summary.errors++
      errorLog.push({
        agent: adapter.name,
        stage: 'discover',
        message: logErr(adapter.name, 'discover', agentSourceDir, err),
      })
      await reportProgress(opts, { agent: adapter.name, phase: 'error' })
      continue
    }
    scannedAgents.add(adapter.name)
    await reportProgress(opts, {
      agent: adapter.name,
      phase: 'processing',
      current: 0,
      total: sessions.length,
    })

      throwIfAborted(opts.signal)
      for (const [index, session] of sessions.entries()) {
        throwIfAborted(opts.signal)
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
        throwIfAborted(opts.signal)
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

        throwIfAborted(opts.signal)
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
          summary.changes.new.push({
            agent: session.agent,
            id: session.id,
            slug,
          })
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
          if (state === 'updated') {
            summary.updated++
            summary.changes.updated.push({
              agent: session.agent,
              id: session.id,
              slug,
            })
          } else {
            summary.unchanged++
          }
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

        const current = index + 1
        if (current === sessions.length || current % 100 === 0) {
          await reportProgress(opts, {
            agent: adapter.name,
            phase: 'processing',
            current,
            total: sessions.length,
          })
        }
      }
      await reportProgress(opts, {
        agent: adapter.name,
        phase: 'done',
        current: sessions.length,
        total: sessions.length,
      })
    }

    // missing 处理：本轮扫的 agent 范围内、DB 有但本轮未发现 → status='missing' + 删 FS link
    if (opts.sinceDays === undefined) {
      throwIfAborted(opts.signal)
      const allRows = db
        .prepare('SELECT id, agent, slug, status FROM sessions')
        .all() as Array<{ id: string; agent: string; slug: string; status: string }>

      for (const row of allRows) {
        throwIfAborted(opts.signal)
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
          summary.changes.missing.push({
            agent: row.agent as AgentAdapter['name'],
            id: row.id,
            slug: row.slug,
          })
        }
      }
    }

    const finalStatus = summary.errors > 0 ? 'partial' : 'success'
    db.prepare(
      `UPDATE run_metadata SET ended_at = ?, status = ?, details = ? WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      finalStatus,
      JSON.stringify(scanRunDetails(opts, summary, errorLog)),
      runId,
    )

    return summary
  } catch (error) {
    const cancelled = isRunCancelledError(error) || opts.signal?.aborted
    db.prepare(
      `UPDATE run_metadata SET ended_at = ?, status = ?, details = ? WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      cancelled ? 'cancelled' : 'failed',
      JSON.stringify({
        ...scanRunDetails(opts, summary, errorLog),
        ...(cancelled
          ? {}
          : { failure: error instanceof Error ? error.message : String(error) }),
      }),
      runId,
    )
    throw error
  } finally {
    db.close()
  }
}

function scanRunDetails(
  opts: ScanOptions,
  summary: ScanSummary,
  errors: ScanErrorEntry[],
): Record<string, unknown> {
  return {
    summary,
    errors,
    scope:
      opts.sinceDays === undefined
        ? { mode: 'full' }
        : { mode: 'recent', days: opts.sinceDays },
  }
}
