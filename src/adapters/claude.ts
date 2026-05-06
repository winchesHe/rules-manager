import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AgentAdapter, DiscoveredSession } from '../types.js'
import { fileHash, fileMtime, readFirstLine, isUuid } from './shared.js'

function collectJsonlFiles(dir: string): string[] {
  const result: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...collectJsonlFiles(fullPath))
    } else if (entry.name.endsWith('.jsonl')) {
      result.push(fullPath)
    }
  }
  return result.sort()
}

function hashFiles(files: string[]): string {
  const hash = crypto.createHash('sha256')
  for (const f of files) {
    hash.update(fs.readFileSync(f))
  }
  return hash.digest('hex')
}

export const claudeAdapter: AgentAdapter = {
  name: 'claude',

  async discover(agentSourceDir: string): Promise<DiscoveredSession[]> {
    const projectsDir = path.join(agentSourceDir, 'projects')
    if (!fs.existsSync(projectsDir)) return []

    const sessions: DiscoveredSession[] = []

    for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue
      const projectDir = path.join(projectsDir, projectEntry.name)

      for (const sessionEntry of fs.readdirSync(projectDir, { withFileTypes: true })) {
        // UUID directory → session whose content spans all .jsonl files within
        if (sessionEntry.isDirectory() && isUuid(sessionEntry.name)) {
          const sessionDir = path.join(projectDir, sessionEntry.name)
          const files = collectJsonlFiles(sessionDir)
          if (files.length === 0) continue

          let updatedAt = fileMtime(files[0])
          try {
            const firstLine = readFirstLine(files[0])
            const obj = JSON.parse(firstLine) as Record<string, unknown>
            if (typeof obj.timestamp === 'string') {
              updatedAt = obj.timestamp
            }
          } catch {
            // use mtime
          }

          sessions.push({
            id: sessionEntry.name,
            agent: 'claude',
            sourcePath: sessionDir,
            sourceKind: 'jsonl',
            updatedAt,
            contentHash: hashFiles(files),
          })
        }

        // UUID.jsonl file → direct session file
        else if (
          sessionEntry.isFile() &&
          sessionEntry.name.endsWith('.jsonl') &&
          isUuid(sessionEntry.name.slice(0, -6))
        ) {
          const filePath = path.join(projectDir, sessionEntry.name)
          const id = sessionEntry.name.slice(0, -6)

          let updatedAt = fileMtime(filePath)
          try {
            const firstLine = readFirstLine(filePath)
            const obj = JSON.parse(firstLine) as Record<string, unknown>
            if (typeof obj.timestamp === 'string') {
              updatedAt = obj.timestamp
            }
          } catch {
            // use mtime
          }

          sessions.push({
            id,
            agent: 'claude',
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
