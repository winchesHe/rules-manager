import fs from 'node:fs'
import path from 'node:path'
import type { AgentAdapter, DiscoveredSession } from '../types.js'
import { fileHash, fileMtime, isUuid } from './shared.js'

export const cursorAdapter: AgentAdapter = {
  name: 'cursor',

  async discover(agentSourceDir: string): Promise<DiscoveredSession[]> {
    const projectsDir = path.join(agentSourceDir, 'projects')
    if (!fs.existsSync(projectsDir)) return []

    const sessions: DiscoveredSession[] = []

    for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue
      const projectDir = path.join(projectsDir, projectEntry.name)

      const transcriptsDir = path.join(projectDir, 'agent-transcripts')
      if (!fs.existsSync(transcriptsDir)) continue

      for (const sessionEntry of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
        if (!sessionEntry.isDirectory() || !isUuid(sessionEntry.name)) continue

        const sessionDir = path.join(transcriptsDir, sessionEntry.name)
        const sessionFile = path.join(sessionDir, `${sessionEntry.name}.jsonl`)
        if (!fs.existsSync(sessionFile)) continue

        sessions.push({
          id: sessionEntry.name,
          agent: 'cursor',
          sourcePath: sessionFile,
          sourceKind: 'jsonl',
          updatedAt: fileMtime(sessionFile),
          contentHash: fileHash(sessionFile),
        })
      }
    }

    return sessions
  },
}
