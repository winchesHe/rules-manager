import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type {
  AgentAdapter,
  DiscoveredSession,
  NormalizedSession,
  ParsedSession,
  ProjectHint,
  ScanOptions,
  ScanSummary,
} from './types.js'
import { ALL_ADAPTERS, getAdapters } from './adapters/index.js'
import { classifyHints } from './classifier.js'
import { initDatabase } from './db.js'
import { rebuildProjectsSummary } from './projects.js'
import { resolveWorkspace } from './workspace.js'

interface SessionRow {
  id: string
  updated_at: string
  content_hash: string
}

interface ScanErrorEntry {
  id?: string
  agent: string
  stage: 'discover' | 'parse' | 'normalize' | 'db'
  message: string
}

export function determineScanState(
  discovered: DiscoveredSession,
  existing: SessionRow | undefined,
): 'new' | 'updated' | 'unchanged' {
  if (!existing) return 'new'
  if (existing.updated_at !== discovered.updatedAt || existing.content_hash !== discovered.contentHash) {
    return 'updated'
  }
  return 'unchanged'
}

function logErr(agent: string, stage: ScanErrorEntry['stage'], detail: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[scan] ${agent} ${stage} failed at ${detail}: ${message}`)
  return message
}

export async function runScan(opts: ScanOptions): Promise<ScanSummary> {
  const { workspaceDir } = resolveWorkspace(opts.homeDir)
  const db = initDatabase(opts.homeDir)
  const now = new Date().toISOString()
  const runId = crypto.randomUUID()

  // run_metadata: 起始行
  db.prepare(
    `INSERT INTO run_metadata (id, run_type, started_at, status) VALUES (?, 'scan', ?, 'running')`,
  ).run(runId, now)

  // --full 短期等价于 --all：覆盖所有内置 agent。
  const useAllAdapters = opts.all || opts.full
  const adapters: AgentAdapter[] = useAllAdapters
    ? ALL_ADAPTERS
    : getAdapters(opts.agents ?? [])

  // 默认 source 路径与工作区对齐：~/.memory-manager/sources/<agent>/。
  // config.toml 落地后会再叠加 custom source；当前未指定 --source 且工作区无 sources/ 时，
  // adapter 会因目录不存在而 continue，summary.total = 0。
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

  const getSession = db.prepare('SELECT id, updated_at, content_hash FROM sessions WHERE id = ?')

  const insertSession = db.prepare(`
    INSERT INTO sessions
      (id, agent, source_path, source_kind, updated_at, content_hash,
       scan_state, first_seen_at, last_seen_at,
       message_count, tool_call_count, first_timestamp, last_timestamp, parsed_metadata)
    VALUES
      (@id, @agent, @source_path, @source_kind, @updated_at, @content_hash,
       @scan_state, @first_seen_at, @last_seen_at,
       @message_count, @tool_call_count, @first_timestamp, @last_timestamp, @parsed_metadata)
  `)

  const updateSession = db.prepare(`
    UPDATE sessions SET
      source_path     = @source_path,
      source_kind     = @source_kind,
      updated_at      = @updated_at,
      content_hash    = @content_hash,
      scan_state      = @scan_state,
      last_seen_at    = @last_seen_at,
      message_count   = @message_count,
      tool_call_count = @tool_call_count,
      first_timestamp = @first_timestamp,
      last_timestamp  = @last_timestamp,
      parsed_metadata = @parsed_metadata
    WHERE id = @id
  `)

  // Plan 04 R1：项目归类相关 statements
  const setSessionProjectKey = db.prepare(
    'UPDATE sessions SET project_key = ? WHERE id = ?',
  )
  const upsertSessionProject = db.prepare(`
    INSERT INTO session_projects (session_id, project_key, confidence, decided_at)
    VALUES (@session_id, @project_key, @confidence, @decided_at)
    ON CONFLICT(session_id) DO UPDATE SET
      project_key = excluded.project_key,
      confidence  = excluded.confidence,
      decided_at  = excluded.decided_at
  `)
  const deleteHintsForSession = db.prepare(
    'DELETE FROM project_hints WHERE session_id = ?',
  )
  const insertProjectHint = db.prepare(`
    INSERT OR REPLACE INTO project_hints
      (session_id, kind, value, project_key, confidence, agent, source, locator, updated_at)
    VALUES
      (@session_id, @kind, @value, @project_key, @confidence, @agent, @source, @locator, @updated_at)
  `)

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

      // parse → normalize；任一阶段失败 → 写 'error' 行
      let parsed: ParsedSession | undefined
      let normalized: NormalizedSession | undefined
      let stageFailed: 'parse' | 'normalize' | undefined
      try {
        parsed = await adapter.parse(session)
      } catch (err) {
        stageFailed = 'parse'
        errorLog.push({
          id: session.id,
          agent: adapter.name,
          stage: 'parse',
          message: logErr(adapter.name, 'parse', session.id, err),
        })
      }
      if (parsed && !stageFailed) {
        try {
          normalized = await adapter.normalize(parsed, session)
        } catch (err) {
          stageFailed = 'normalize'
          errorLog.push({
            id: session.id,
            agent: adapter.name,
            stage: 'normalize',
            message: logErr(adapter.name, 'normalize', session.id, err),
          })
        }
      }

      const existing = getSession.get(session.id) as SessionRow | undefined
      const isError = stageFailed !== undefined
      if (isError) summary.errors++

      const state = isError
        ? 'error'
        : determineScanState(session, existing)

      // 'error' 行也要落库以便诊断；写库本身失败才计入 db error。
      // sessions.updated_at 保持 discover 语义（决定 new/updated/unchanged 的稳定基准）；
      // normalize.updatedAt 是 Plan 04/05 用的便利字段，落到 last_timestamp 列即可。
      const updatedAt = session.updatedAt
      const contentHash = normalized?.contentHash ?? session.contentHash
      const messageCount = parsed?.messageCount ?? 0
      const toolCallCount = parsed?.toolCallCount ?? 0
      const firstTimestamp = parsed?.firstTimestamp ?? null
      const lastTimestamp = parsed?.lastTimestamp ?? null
      const parsedMetadata = parsed ? JSON.stringify(parsed.metadata) : null

      try {
        if (!existing) {
          insertSession.run({
            id: session.id,
            agent: session.agent,
            source_path: session.sourcePath,
            source_kind: session.sourceKind,
            updated_at: updatedAt,
            content_hash: contentHash,
            scan_state: state,
            first_seen_at: now,
            last_seen_at: now,
            message_count: messageCount,
            tool_call_count: toolCallCount,
            first_timestamp: firstTimestamp,
            last_timestamp: lastTimestamp,
            parsed_metadata: parsedMetadata,
          })
          if (!isError) summary.new++
        } else {
          updateSession.run({
            id: session.id,
            source_path: session.sourcePath,
            source_kind: session.sourceKind,
            updated_at: updatedAt,
            content_hash: contentHash,
            scan_state: state,
            last_seen_at: now,
            message_count: messageCount,
            tool_call_count: toolCallCount,
            first_timestamp: firstTimestamp,
            last_timestamp: lastTimestamp,
            parsed_metadata: parsedMetadata,
          })
          if (!isError) {
            if (state === 'updated') summary.updated++
            else summary.unchanged++
          }
        }
      } catch (err) {
        // db 写库失败：未计 errors 时计入；已计入则只记日志（避免 parse+db 双计）。
        if (!isError) summary.errors++
        errorLog.push({
          id: session.id,
          agent: adapter.name,
          stage: 'db',
          message: logErr(adapter.name, 'db', session.id, err),
        })
      }

      // Plan 04 R1：仅对非 error session 抽 hints + 分类。
      // extractProjectHints 抛错不影响主链路，记日志即可。
      if (!isError) {
        let hints: ProjectHint[] = []
        try {
          hints = await adapter.extractProjectHints(session)
        } catch (err) {
          logErr(adapter.name, 'parse', `${session.id} (extractProjectHints)`, err)
        }
        const classification = classifyHints(hints)

        try {
          setSessionProjectKey.run(classification.projectKey, session.id)
          upsertSessionProject.run({
            session_id: session.id,
            project_key: classification.projectKey,
            confidence: classification.confidence,
            decided_at: now,
          })
          // 重新扫描时清空旧 hints 再写入，避免重复堆积或无效残留
          deleteHintsForSession.run(session.id)
          for (const h of hints) {
            insertProjectHint.run({
              session_id: session.id,
              kind: h.kind,
              value: h.value,
              project_key: classification.projectKey,
              confidence: h.confidence,
              agent: h.agent,
              source: h.source,
              locator: h.locator ?? null,
              updated_at: now,
            })
          }
        } catch (err) {
          // hints/project 写库失败不计 summary.errors（主 session 已落库），仅记日志
          logErr(adapter.name, 'db', `${session.id} (project_hints)`, err)
        }
      }
    }
  }

  // 把"本轮扫到的 agent 范围内、DB 中存在但本轮未发现"的会话标记为 missing。
  // 只统计本轮新转入 missing 的（即先前 scan_state 不是 'missing' 的），
  // 避免每次扫描都把同一会话重复计入 summary.missing。
  const allRows = db
    .prepare('SELECT id, agent, scan_state FROM sessions')
    .all() as Array<{ id: string; agent: string; scan_state: string }>

  const markMissing = db.prepare("UPDATE sessions SET scan_state = 'missing' WHERE id = ?")
  for (const row of allRows) {
    if (
      scannedAgents.has(row.agent) &&
      !discoveredIds.has(row.id) &&
      row.scan_state !== 'missing'
    ) {
      markMissing.run(row.id)
      summary.missing++
    }
  }

  // Plan 04 R1+R2：projects 表汇总（公共逻辑，assign/merge/reclassify 共用）
  rebuildProjectsSummary(db, now)

  // run_metadata: 收尾行
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
