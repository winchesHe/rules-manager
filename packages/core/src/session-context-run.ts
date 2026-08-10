import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionEvent, SessionEventReadResult } from './session-events.js'
import type {
  MatchProof,
  SelectionCoverage,
  SessionQuery,
  SessionQueryExecution,
  SessionSelectionOutcome,
} from './session-query.js'
import type { AgentName } from './types.js'

export const SESSION_CONTEXT_RUN_SCHEMA_VERSION = 1 as const
export const DEFAULT_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000
export const DEFAULT_CONTEXT_PART_BYTES = 512 * 1024

const RUN_PREFIX = 'memory-manager-context-'
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface SessionContextManifestSession {
  id: string
  agent: AgentName
  projectSlug?: string
  eventCount: number
  partCount: number
  directory?: string
  sourceRevision?: SessionEventReadResult['sourceRevision']
  proofs: MatchProof[]
}

export interface SessionContextManifest {
  schemaVersion: typeof SESSION_CONTEXT_RUN_SCHEMA_VERSION
  runId: string
  query: SessionQuery
  queryHash: string
  evaluatedAt: string
  createdAt: string
  expiresAt: string
  coverage: SelectionCoverage
  outcomes: SessionSelectionOutcome[]
  sessions: SessionContextManifestSession[]
}

export interface SessionContextPart {
  runId: string
  sessionId: string
  agent: AgentName
  part: number
  partCount: number
  eventCount: number
  events: SessionEvent[]
}

export interface CreateSessionContextRunOptions {
  parentDir?: string
  now?: Date
  ttlMs?: number
  maxPartBytes?: number
}

export interface SessionContextRunSummary {
  runId: string
  createdAt: string
  expiresAt: string
  queryHash: string
  coverage: SelectionCoverage
  outcomes: SessionSelectionOutcome[]
  sessions: SessionContextManifestSession[]
  limitations: string[]
}

export interface SessionContextRunWriter {
  runId: string
  writeMatchedSession: (
    source: SessionEventReadResult,
    outcome: SessionSelectionOutcome,
  ) => void
  finalize: (execution: SessionQueryExecution) => SessionContextRunSummary
  cleanup: () => void
}

function contextParentDir(parentDir?: string): string {
  return parentDir ?? path.join(os.tmpdir(), 'memory-manager-context-runs')
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`无效 context run id：${runId}`)
}

function runDirectory(runId: string, parentDir?: string): string {
  assertRunId(runId)
  return path.join(contextParentDir(parentDir), `${RUN_PREFIX}${runId}`)
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  fs.chmodSync(filePath, 0o600)
}

function safeChildPath(rootDir: string, relativePath: string): string {
  const resolvedRoot = path.resolve(rootDir)
  const resolved = path.resolve(rootDir, relativePath)
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`context manifest 包含越界路径：${relativePath}`)
  }
  return resolved
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
  } catch {
    throw new Error(`context 文件损坏：${filePath}`)
  }
}

function isManifest(value: unknown): value is SessionContextManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === SESSION_CONTEXT_RUN_SCHEMA_VERSION
    && typeof record.runId === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.expiresAt === 'string'
    && Array.isArray(record.sessions)
    && Array.isArray(record.outcomes)
}

function loadManifest(runId: string, parentDir?: string): {
  rootDir: string
  manifest: SessionContextManifest
} {
  const rootDir = runDirectory(runId, parentDir)
  if (!fs.existsSync(rootDir)) throw new Error(`context run 不存在：${runId}`)
  const value = readJson(path.join(rootDir, 'manifest.json'))
  if (!isManifest(value) || value.runId !== runId) {
    throw new Error(`context run manifest 校验失败：${runId}`)
  }
  return { rootDir, manifest: value }
}

function serializedEventBytes(event: SessionEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
}

export function partitionSessionEvents(
  events: SessionEvent[],
  maxPartBytes = DEFAULT_CONTEXT_PART_BYTES,
): SessionEvent[][] {
  if (!Number.isInteger(maxPartBytes) || maxPartBytes <= 0) {
    throw new Error('maxPartBytes 必须是正整数')
  }
  const parts: SessionEvent[][] = []
  let current: SessionEvent[] = []
  let currentBytes = 0
  for (const event of events) {
    const bytes = serializedEventBytes(event)
    if (current.length > 0 && currentBytes + bytes > maxPartBytes) {
      parts.push(current)
      current = []
      currentBytes = 0
    }
    current.push(event)
    currentBytes += bytes
  }
  if (current.length > 0) parts.push(current)
  return parts
}

function limitationsFor(coverage: SelectionCoverage): string[] {
  const limitations: string[] = []
  if (coverage.unknown > 0) {
    limitations.push(`${coverage.unknown} 个候选 Session 无法检查，不能声明已找到全部相关 Session`)
  }
  if (coverage.changedDuringRun > 0) {
    limitations.push(`${coverage.changedDuringRun} 个 Session 在读取期间发生变化，本轮使用已冻结水位`)
  }
  return limitations
}

export function createSessionContextRun(
  execution: SessionQueryExecution,
  options: CreateSessionContextRunOptions = {},
): SessionContextRunSummary {
  const writer = createSessionContextRunWriter(options)
  try {
    const outcomeById = new Map(execution.outcomes.map((outcome) => [outcome.sessionId, outcome]))
    for (const source of execution.matchedSources) {
      const outcome = outcomeById.get(source.sessionId)
      if (!outcome) throw new Error(`缺少 Session selection outcome：${source.sessionId}`)
      writer.writeMatchedSession(source, outcome)
    }
    return writer.finalize(execution)
  } catch (error) {
    writer.cleanup()
    throw error
  }
}

export function createSessionContextRunWriter(
  options: CreateSessionContextRunOptions = {},
): SessionContextRunWriter {
  const now = options.now ?? new Date()
  const ttlMs = options.ttlMs ?? DEFAULT_CONTEXT_TTL_MS
  const maxPartBytes = options.maxPartBytes ?? DEFAULT_CONTEXT_PART_BYTES
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs 必须大于 0')
  const runId = crypto.randomUUID()
  const parentDir = contextParentDir(options.parentDir)
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(parentDir, 0o700)
  const rootDir = runDirectory(runId, parentDir)
  fs.mkdirSync(rootDir, { mode: 0o700 })
  fs.chmodSync(rootDir, 0o700)
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
  writePrivateJson(path.join(rootDir, 'owner.json'), {
    runId,
    state: 'preparing',
    createdAt,
    expiresAt,
  })
  const sessions: SessionContextManifestSession[] = []
  let finalized = false
  let cleaned = false

  function cleanup(): void {
    if (cleaned || finalized) return
    cleaned = true
    fs.rmSync(rootDir, { recursive: true, force: true })
  }

  function writeMatchedSession(
    source: SessionEventReadResult,
    outcome: SessionSelectionOutcome,
  ): void {
    if (finalized || cleaned) throw new Error('context run writer 已结束')
    if (source.sessionId !== outcome.sessionId || outcome.selectionStatus !== 'matched') {
      throw new Error(`Session selection outcome 与 source 不一致：${source.sessionId}`)
    }
    if (sessions.some((session) => session.id === source.sessionId)) {
      throw new Error(`Session 已写入 context run：${source.sessionId}`)
    }
    const index = sessions.length
    const parts = partitionSessionEvents(source.events, maxPartBytes)
    const directory = parts.length > 0
      ? path.join('sessions', `session-${String(index + 1).padStart(4, '0')}`)
      : undefined
    if (directory) {
      const sessionDir = safeChildPath(rootDir, directory)
      fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
      fs.chmodSync(sessionDir, 0o700)
      parts.forEach((events, partIndex) => {
        const part = partIndex + 1
        writePrivateJson(path.join(
          sessionDir,
          `part-${String(part).padStart(4, '0')}.json`,
        ), {
          runId,
          sessionId: source.sessionId,
          agent: source.agent,
          part,
          partCount: parts.length,
          eventCount: events.length,
          events,
        } satisfies SessionContextPart)
      })
    }
    sessions.push({
      id: source.sessionId,
      agent: source.agent,
      projectSlug: source.projectSlug,
      eventCount: source.eventCount,
      partCount: parts.length,
      ...(directory ? { directory } : {}),
      sourceRevision: source.sourceRevision,
      proofs: outcome.proofs,
    })
  }

  function finalize(execution: SessionQueryExecution): SessionContextRunSummary {
    if (finalized || cleaned) throw new Error('context run writer 已结束')
    if (sessions.length !== execution.coverage.matched) {
      throw new Error(
        `context run 写入 Session 数 ${sessions.length} 与 matched ${execution.coverage.matched} 不一致`,
      )
    }
    const manifest: SessionContextManifest = {
      schemaVersion: SESSION_CONTEXT_RUN_SCHEMA_VERSION,
      runId,
      query: execution.query,
      queryHash: execution.queryHash,
      evaluatedAt: execution.evaluatedAt,
      createdAt,
      expiresAt,
      coverage: execution.coverage,
      outcomes: execution.outcomes,
      sessions,
    }
    writePrivateJson(path.join(rootDir, 'manifest.json'), manifest)
    writePrivateJson(path.join(rootDir, 'owner.json'), {
      runId,
      state: 'ready',
      createdAt,
      expiresAt,
    })
    finalized = true
    return {
      runId,
      createdAt,
      expiresAt,
      queryHash: execution.queryHash,
      coverage: execution.coverage,
      outcomes: execution.outcomes,
      sessions,
      limitations: limitationsFor(execution.coverage),
    }
  }

  try {
    return {
      runId,
      writeMatchedSession,
      finalize,
      cleanup,
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

export function readSessionContextPart(
  runId: string,
  sessionId: string,
  part: number,
  parentDir?: string,
): SessionContextPart {
  if (!Number.isInteger(part) || part < 1) throw new Error('part 必须是从 1 开始的整数')
  const { rootDir, manifest } = loadManifest(runId, parentDir)
  const session = manifest.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error(`context run 中没有 Session：${sessionId}`)
  if (!session.directory || session.partCount === 0) {
    throw new Error(`Session 没有可读取分片：${sessionId}`)
  }
  if (part > session.partCount) {
    throw new Error(`Session ${sessionId} 只有 ${session.partCount} 个分片`)
  }
  const filePath = safeChildPath(
    rootDir,
    path.join(session.directory, `part-${String(part).padStart(4, '0')}.json`),
  )
  const value = readJson(filePath)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`context part 校验失败：${filePath}`)
  }
  const record = value as Record<string, unknown>
  if (
    record.runId !== runId
    || record.sessionId !== sessionId
    || record.part !== part
    || !Array.isArray(record.events)
  ) {
    throw new Error(`context part 校验失败：${filePath}`)
  }
  return value as SessionContextPart
}

export function getSessionContextStatus(
  runId: string,
  parentDir?: string,
): SessionContextRunSummary {
  const { manifest } = loadManifest(runId, parentDir)
  return {
    runId: manifest.runId,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    queryHash: manifest.queryHash,
    coverage: manifest.coverage,
    outcomes: manifest.outcomes,
    sessions: manifest.sessions,
    limitations: limitationsFor(manifest.coverage),
  }
}

export function closeSessionContextRun(
  runId: string,
  parentDir?: string,
): { runId: string; status: 'closed' | 'not_found' } {
  const rootDir = runDirectory(runId, parentDir)
  if (!fs.existsSync(rootDir)) return { runId, status: 'not_found' }
  loadManifest(runId, parentDir)
  fs.rmSync(rootDir, { recursive: true, force: true })
  return { runId, status: 'closed' }
}

export function cleanupStaleSessionContextRuns(options: {
  parentDir?: string
  now?: Date
} = {}): string[] {
  const parentDir = contextParentDir(options.parentDir)
  if (!fs.existsSync(parentDir)) return []
  const now = (options.now ?? new Date()).getTime()
  const removed: string[] = []
  for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUN_PREFIX)) continue
    const runId = entry.name.slice(RUN_PREFIX.length)
    if (!RUN_ID_PATTERN.test(runId)) continue
    try {
      const rootDir = runDirectory(runId, parentDir)
      let expiresAt: string
      try {
        expiresAt = loadManifest(runId, parentDir).manifest.expiresAt
      } catch {
        const owner = readJson(path.join(rootDir, 'owner.json'))
        if (!owner || typeof owner !== 'object' || Array.isArray(owner)) continue
        const record = owner as Record<string, unknown>
        if (record.runId !== runId || typeof record.expiresAt !== 'string') continue
        expiresAt = record.expiresAt
      }
      if (Date.parse(expiresAt) > now) continue
      fs.rmSync(runDirectory(runId, parentDir), { recursive: true, force: true })
      removed.push(runId)
    } catch {
      // 只清理 manifest 可验证且确已过期的本工具目录。
    }
  }
  return removed
}
