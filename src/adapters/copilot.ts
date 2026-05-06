import fs from 'node:fs'
import path from 'node:path'
import type { AgentAdapter, DiscoveredSession } from '../types.js'
import { fileHash, fileMtime, readFirstLine, isUuid } from './shared.js'

export const copilotAdapter: AgentAdapter = {
  name: 'copilot',

  async discover(agentSourceDir: string): Promise<DiscoveredSession[]> {
    const sessionStateDir = path.join(agentSourceDir, 'session-state')
    if (!fs.existsSync(sessionStateDir)) return []

    const sessions: DiscoveredSession[] = []

    for (const entry of fs.readdirSync(sessionStateDir)) {
      if (!isUuid(entry)) continue
      const sessionDir = path.join(sessionStateDir, entry)
      if (!fs.statSync(sessionDir).isDirectory()) continue

      const eventsFile = path.join(sessionDir, 'events.jsonl')
      if (!fs.existsSync(eventsFile)) continue

      let updatedAt = fileMtime(eventsFile)
      try {
        const firstLine = readFirstLine(eventsFile)
        const event = JSON.parse(firstLine) as Record<string, unknown>
        const data = event.data as Record<string, unknown> | undefined
        if (event.type === 'session.start' && typeof data?.startTime === 'string') {
          updatedAt = data.startTime
        }
      } catch {
        // use mtime
      }

      sessions.push({
        id: entry,
        agent: 'copilot',
        sourcePath: eventsFile,
        sourceKind: 'jsonl',
        updatedAt,
        contentHash: fileHash(eventsFile),
      })
    }

    return sessions
  },
}
