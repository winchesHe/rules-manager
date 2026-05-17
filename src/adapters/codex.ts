import fs from 'node:fs'
import path from 'node:path'
import type {
  AgentAdapter,
  DiscoveredSession,
  ParsedSession,
  ProjectHint,
} from '../types.js'
import {
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
    const sessionsDir = path.join(agentSourceDir, 'sessions')
    if (!fs.existsSync(sessionsDir)) return []

    const sessions: DiscoveredSession[] = []

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

      sessions.push({
        id: sessionId,
        agent: 'codex',
        sourcePath: filePath,
        sourceKind: 'jsonl',
        updatedAt,
        contentHash: fileHash(filePath),
      })
    }

    // sessions/YYYY/MM/ 下面同时支持两种布局：
    //   - 旧：MM/<file>.jsonl（fixture 现状）
    //   - 新：MM/DD/<file>.jsonl（codex 2026-05+ 本机真实布局）
    // 只下钻 1 层（DD），不再深入。
    for (const yearEntry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!yearEntry.isDirectory()) continue
      const yearDir = path.join(sessionsDir, yearEntry.name)

      for (const monthEntry of fs.readdirSync(yearDir, { withFileTypes: true })) {
        if (!monthEntry.isDirectory()) continue
        const monthDir = path.join(yearDir, monthEntry.name)

        for (const entry of fs.readdirSync(monthDir, { withFileTypes: true })) {
          if (entry.isFile()) {
            collectFile(path.join(monthDir, entry.name))
          } else if (entry.isDirectory()) {
            const dayDir = path.join(monthDir, entry.name)
            for (const fileEntry of fs.readdirSync(dayDir, { withFileTypes: true })) {
              if (fileEntry.isFile()) collectFile(path.join(dayDir, fileEntry.name))
            }
          }
        }
      }
    }

    return sessions
  },
}
