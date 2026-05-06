import fs from 'node:fs'
import path from 'node:path'
import type { AgentAdapter, DiscoveredSession, ProjectHint } from '../types.js'
import { fileHash, fileMtime, readFirstLine, isUuid } from './shared.js'

export const copilotAdapter: AgentAdapter = {
  name: 'copilot',

  async probe(agentSourceDir: string) {
    const sessionStateDir = path.join(agentSourceDir, 'session-state')
    if (!fs.existsSync(sessionStateDir)) {
      return { matched: false, reason: 'no session-state/ directory' }
    }
    // 区分点：copilot 的 session-state/ 直接是 UUID 命名的子目录
    for (const entry of fs.readdirSync(sessionStateDir, { withFileTypes: true })) {
      if (entry.isDirectory() && isUuid(entry.name)) return { matched: true }
    }
    return { matched: false, reason: 'no UUID-named session directory under session-state/' }
  },

  async extractProjectHints(discovered: DiscoveredSession): Promise<ProjectHint[]> {
    const hints: ProjectHint[] = []
    if (!fs.existsSync(discovered.sourcePath)) return hints

    try {
      const obj = JSON.parse(readFirstLine(discovered.sourcePath)) as Record<string, unknown>
      if (obj.type !== 'session.start') return hints
      const data = obj.data as Record<string, unknown> | undefined
      const ctx = data?.context as Record<string, unknown> | undefined
      if (!ctx) return hints

      if (typeof ctx.gitRoot === 'string' && ctx.gitRoot) {
        hints.push({
          kind: 'git_root',
          value: ctx.gitRoot,
          confidence: 0.95,
          agent: 'copilot',
          source: 'metadata',
          locator: 'session.start.data.context.gitRoot',
        })
      }
      if (typeof ctx.cwd === 'string' && ctx.cwd) {
        hints.push({
          kind: 'cwd',
          value: ctx.cwd,
          confidence: 0.9,
          agent: 'copilot',
          source: 'metadata',
          locator: 'session.start.data.context.cwd',
        })
      }
      if (typeof ctx.branch === 'string' && ctx.branch) {
        hints.push({
          kind: 'branch',
          value: ctx.branch,
          confidence: 0.2,
          agent: 'copilot',
          source: 'metadata',
          locator: 'session.start.data.context.branch',
        })
      }
    } catch {
      // first-line 不是合法 JSON，返回已有 hints（可能为空）
    }
    return hints
  },

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
