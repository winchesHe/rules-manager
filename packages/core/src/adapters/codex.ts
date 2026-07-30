import fs from 'node:fs'
import path from 'node:path'
import type {
  AgentAdapter,
  DiscoveredSession,
  ParsedSession,
  ProjectHint,
} from '../types.js'
import {
  collectFilesRecursive,
  defaultNormalize,
  fileHash,
  fileMtime,
  readFirstLine,
  readJsonlObjects,
} from './shared.js'

// Match UUID at end of filename: some-name-<uuid>.jsonl
const UUID_SUFFIX_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export const codexAdapter: AgentAdapter = {
  name: 'codex',

  async probe(agentSourceDir: string) {
    const sessionsDir = path.join(agentSourceDir, 'sessions')
    if (!fs.existsSync(sessionsDir)) return { matched: false, reason: 'no sessions/ directory' }
    // 区分点：codex 的 sessions/ 下是数字年份子目录
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d{4}$/.test(entry.name)) return { matched: true }
    }
    return { matched: false, reason: 'no YYYY year directory under sessions/' }
  },

  async parse(discovered: DiscoveredSession): Promise<ParsedSession> {
    const parsed: ParsedSession = {
      agent: 'codex',
      sessionId: discovered.id,
      sourcePath: discovered.sourcePath,
      messageCount: 0,
      toolCallCount: 0,
      metadata: {},
    }
    if (!fs.existsSync(discovered.sourcePath)) return parsed

    const objs = readJsonlObjects(discovered.sourcePath)
    let firstTs: string | undefined
    let lastTs: string | undefined

    for (const obj of objs) {
      if (typeof obj.timestamp === 'string') {
        if (!firstTs) firstTs = obj.timestamp
        lastTs = obj.timestamp
      }
      if (obj.type === 'response_item') {
        const payload = obj.payload as Record<string, unknown> | undefined
        const pType = payload?.type
        if (pType === 'message' || pType === 'agent_message' || pType === 'user_message') {
          parsed.messageCount++
        } else if (pType === 'function_call' || pType === 'custom_tool_call') {
          parsed.toolCallCount++
        }
      } else if (obj.type === 'session_meta') {
        const payload = obj.payload as Record<string, unknown> | undefined
        if (typeof payload?.cwd === 'string') parsed.metadata.cwd = payload.cwd
        const git = payload?.git as Record<string, unknown> | undefined
        if (typeof git?.branch === 'string') parsed.metadata.branch = git.branch
        if (typeof git?.commit_hash === 'string') parsed.metadata.headCommit = git.commit_hash
      }
    }

    if (firstTs) parsed.firstTimestamp = firstTs
    if (lastTs) parsed.lastTimestamp = lastTs
    return parsed
  },

  normalize: defaultNormalize,

  async extractProjectHints(discovered: DiscoveredSession): Promise<ProjectHint[]> {
    const hints: ProjectHint[] = []
    if (!fs.existsSync(discovered.sourcePath)) return hints

    try {
      const obj = JSON.parse(readFirstLine(discovered.sourcePath)) as Record<string, unknown>
      const payload = obj.payload as Record<string, unknown> | undefined
      if (obj.type === 'session_meta' && typeof payload?.cwd === 'string' && payload.cwd) {
        hints.push({
          kind: 'cwd',
          value: payload.cwd,
          confidence: 0.9,
          agent: 'codex',
          source: 'metadata',
          locator: 'session_meta.payload.cwd',
        })
      }
    } catch {
      // first-line 不是合法 JSON 或缺字段：返回空
    }
    return hints
  },

  async discover(agentSourceDir: string): Promise<DiscoveredSession[]> {
    const roots = [
      path.join(agentSourceDir, 'sessions'),
      path.join(agentSourceDir, 'archived_sessions'),
    ]
    const sessions = new Map<string, DiscoveredSession>()

    const collectFile = (filePath: string): void => {
      const match = UUID_SUFFIX_RE.exec(path.basename(filePath))
      if (!match) return
      const sessionId = match[1]

      let updatedAt = fileMtime(filePath)
      try {
        const firstLine = readFirstLine(filePath)
        const event = JSON.parse(firstLine) as Record<string, unknown>
        const payload = event.payload as Record<string, unknown> | undefined
        if (event.type === 'session_meta' && typeof payload?.timestamp === 'string') {
          updatedAt = payload.timestamp
        } else if (typeof event.timestamp === 'string') {
          updatedAt = event.timestamp
        }
      } catch {
        // use mtime
      }

      if (sessions.has(sessionId)) return
      sessions.set(sessionId, {
        id: sessionId,
        agent: 'codex',
        sourcePath: filePath,
        sourceKind: 'jsonl',
        updatedAt,
        contentHash: fileHash(filePath),
      })
    }

    for (const root of roots) {
      for (const filePath of collectFilesRecursive(root, (candidate) => {
        return UUID_SUFFIX_RE.test(path.basename(candidate))
      })) {
        collectFile(filePath)
      }
    }

    return [...sessions.values()]
  },
}
