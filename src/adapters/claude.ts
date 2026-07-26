import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
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
  isUuid,
  readFirstLine,
  readJsonlObjects,
} from './shared.js'

function collectJsonlFiles(dir: string): string[] {
  return collectFilesRecursive(dir, (filePath) => filePath.endsWith('.jsonl'))
}

function readClaudeSessionId(filePath: string): string {
  try {
    const first = JSON.parse(readFirstLine(filePath)) as Record<string, unknown>
    if (typeof first.sessionId === 'string' && first.sessionId.trim()) {
      return first.sessionId.trim()
    }
  } catch {
    // 文件名仍是 Claude 的稳定 provider handle。
  }
  return path.basename(filePath, '.jsonl')
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
    // 区分点：claude 的 projects/<*>/ 直接放 session 目录或 JSONL；
    // cursor 也有 projects/，但子目录是 agent-transcripts/，不会命中下面的判定。
    for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue
      const projectDir = path.join(projectsDir, projectEntry.name)
      for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
        if (entry.isDirectory() && isUuid(entry.name)) return { matched: true }
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          return { matched: true }
        }
      }
    }
    return { matched: false, reason: 'no session JSONL entries' }
  },

  async parse(discovered: DiscoveredSession): Promise<ParsedSession> {
    const parsed: ParsedSession = {
      agent: 'claude',
      sessionId: discovered.id,
      sourcePath: discovered.sourcePath,
      messageCount: 0,
      toolCallCount: 0,
      metadata: {},
    }

    if (!fs.existsSync(discovered.sourcePath)) return parsed

    const stat = fs.statSync(discovered.sourcePath)
    const files = stat.isDirectory()
      ? collectJsonlFiles(discovered.sourcePath)
      : [discovered.sourcePath]

    let firstTs: string | undefined
    let lastTs: string | undefined

    for (const f of files) {
      for (const obj of readJsonlObjects(f)) {
        if (obj.type === 'user' || obj.type === 'assistant') {
          parsed.messageCount++
          if (obj.type === 'assistant') {
            const message = obj.message as Record<string, unknown> | undefined
            const content = message?.content as Array<Record<string, unknown>> | undefined
            if (Array.isArray(content)) {
              for (const part of content) {
                if (part?.type === 'tool_use') parsed.toolCallCount++
              }
            }
          }
        }
        if (typeof obj.timestamp === 'string') {
          if (!firstTs || obj.timestamp < firstTs) firstTs = obj.timestamp
          if (!lastTs || obj.timestamp > lastTs) lastTs = obj.timestamp
        }
      }
    }

    if (firstTs) parsed.firstTimestamp = firstTs
    if (lastTs) parsed.lastTimestamp = lastTs

    // 首行 metadata（cwd / gitBranch）
    if (files.length > 0) {
      try {
        const head = JSON.parse(readFirstLine(files[0])) as Record<string, unknown>
        if (typeof head.cwd === 'string' && head.cwd) parsed.metadata.cwd = head.cwd
        if (typeof head.gitBranch === 'string' && head.gitBranch) {
          parsed.metadata.branch = head.gitBranch
        }
      } catch {
        // 首行非 JSON：保持 metadata 空
      }
    }

    return parsed
  },

  normalize: defaultNormalize,

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

    const sessions = new Map<string, DiscoveredSession>()

    for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue
      const projectDir = path.join(projectsDir, projectEntry.name)

      for (const sessionEntry of fs.readdirSync(projectDir, { withFileTypes: true })) {
        // UUID directory → session whose content spans all .jsonl files within
        if (sessionEntry.isDirectory() && isUuid(sessionEntry.name)) {
          if (sessions.has(sessionEntry.name)) continue
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

          sessions.set(sessionEntry.name, {
            id: sessionEntry.name,
            agent: 'claude',
            sourcePath: sessionDir,
            sourceKind: 'jsonl',
            updatedAt,
            contentHash: hashFiles(files),
          })
        }

        // Claude SDK/Paseo 的 provider handle 通常是文件名，也允许从首行 sessionId 权威化。
        else if (sessionEntry.isFile() && sessionEntry.name.endsWith('.jsonl')) {
          const filePath = path.join(projectDir, sessionEntry.name)
          const sessionId = readClaudeSessionId(filePath)
          if (sessions.has(sessionId)) continue

          sessions.set(sessionId, {
            id: sessionId,
            agent: 'claude',
            sourcePath: filePath,
            sourceKind: 'jsonl',
            updatedAt: fileMtime(filePath),
            contentHash: fileHash(filePath),
          })
        }
      }
    }

    return [...sessions.values()]
  },
}
