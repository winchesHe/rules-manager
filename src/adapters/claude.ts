import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AgentAdapter, DiscoveredSession, ProjectHint } from '../types.js'
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

  async probe(agentSourceDir: string) {
    const projectsDir = path.join(agentSourceDir, 'projects')
    if (!fs.existsSync(projectsDir)) {
      return { matched: false, reason: 'no projects/ directory' }
    }
    // 区分点：claude 的 projects/<*>/ 直接放 UUID 目录或 UUID.jsonl；
    // cursor 也有 projects/，但子目录是 agent-transcripts/，不会命中下面的判定。
    for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue
      const projectDir = path.join(projectsDir, projectEntry.name)
      for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
        if (entry.isDirectory() && isUuid(entry.name)) return { matched: true }
        if (
          entry.isFile() &&
          entry.name.endsWith('.jsonl') &&
          isUuid(entry.name.slice(0, -6))
        ) {
          return { matched: true }
        }
      }
    }
    return { matched: false, reason: 'no UUID-named session entries' }
  },

  async extractProjectHints(discovered: DiscoveredSession): Promise<ProjectHint[]> {
    const hints: ProjectHint[] = []

    // 从 sourcePath 找首个 jsonl 文件，读首行抽 cwd / gitBranch
    let firstJsonl: string | undefined
    if (fs.existsSync(discovered.sourcePath)) {
      const stat = fs.statSync(discovered.sourcePath)
      if (stat.isDirectory()) {
        firstJsonl = collectJsonlFiles(discovered.sourcePath)[0]
      } else if (discovered.sourcePath.endsWith('.jsonl')) {
        firstJsonl = discovered.sourcePath
      }
    }

    if (firstJsonl) {
      try {
        const obj = JSON.parse(readFirstLine(firstJsonl)) as Record<string, unknown>
        if (typeof obj.cwd === 'string' && obj.cwd) {
          hints.push({
            kind: 'cwd',
            value: obj.cwd,
            confidence: 0.9,
            agent: 'claude',
            source: 'metadata',
            locator: 'first_line.cwd',
          })
        }
        if (typeof obj.gitBranch === 'string' && obj.gitBranch) {
          hints.push({
            kind: 'branch',
            value: obj.gitBranch,
            confidence: 0.2,
            agent: 'claude',
            source: 'metadata',
            locator: 'first_line.gitBranch',
          })
        }
      } catch {
        // first-line 不是合法 JSON，跳过 metadata hints
      }
    }

    // 从 sourcePath 中的 projects/<encoded> 段抽出 source_project_path
    // claude 编码会把 / - _ 都映射成 -，无法无损还原；这里返回原始编码值，
    // 由 Plan 04 决定如何降权使用。
    const m = /\/projects\/([^/]+)/.exec(discovered.sourcePath)
    if (m) {
      hints.push({
        kind: 'source_project_path',
        value: m[1],
        confidence: 0.85,
        agent: 'claude',
        source: 'source_path',
      })
    }

    return hints
  },

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
