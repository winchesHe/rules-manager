import fs from 'node:fs'
import path from 'node:path'
import type { AgentAdapter, DiscoveredSession, ProjectHint } from '../types.js'
import { fileHash, fileMtime, readFirstLine } from './shared.js'

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

    // Walk sessions/YYYY/MM/
    for (const year of fs.readdirSync(sessionsDir)) {
      const yearDir = path.join(sessionsDir, year)
      if (!fs.statSync(yearDir).isDirectory()) continue

      for (const month of fs.readdirSync(yearDir)) {
        const monthDir = path.join(yearDir, month)
        if (!fs.statSync(monthDir).isDirectory()) continue

        for (const file of fs.readdirSync(monthDir)) {
          const match = UUID_SUFFIX_RE.exec(file)
          if (!match) continue

          const sessionId = match[1]
          const filePath = path.join(monthDir, file)

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
      }
    }

    return sessions
  },
}
