import fs from 'node:fs'
import path from 'node:path'
import type { AgentAdapter, DiscoveredSession, ProjectHint } from '../types.js'
import { fileHash, fileMtime, isUuid } from './shared.js'

export const cursorAdapter: AgentAdapter = {
  name: 'cursor',

  async probe(agentSourceDir: string) {
    const projectsDir = path.join(agentSourceDir, 'projects')
    if (!fs.existsSync(projectsDir)) {
      return { matched: false, reason: 'no projects/ directory' }
    }
    // 区分点：cursor 的 projects/<*>/agent-transcripts/ —— claude 没有这层目录
    for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue
      const transcripts = path.join(projectsDir, projectEntry.name, 'agent-transcripts')
      if (fs.existsSync(transcripts) && fs.statSync(transcripts).isDirectory()) {
        return { matched: true }
      }
    }
    return { matched: false, reason: 'no agent-transcripts/ directory under any project' }
  },

  async extractProjectHints(discovered: DiscoveredSession): Promise<ProjectHint[]> {
    const hints: ProjectHint[] = []
    // cursor jsonl 没有 cwd / gitRoot 元数据，只能依赖目录编码。
    // sourcePath = .../projects/<encoded>/agent-transcripts/<UUID>/<UUID>.jsonl
    const m = /\/projects\/([^/]+)\/agent-transcripts\//.exec(discovered.sourcePath)
    if (m) {
      hints.push({
        kind: 'source_project_path',
        value: m[1],
        confidence: 0.85,
        agent: 'cursor',
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
