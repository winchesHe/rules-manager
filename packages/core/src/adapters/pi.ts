import fs from 'node:fs'
import os from 'node:os'
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

interface PiSessionHeader {
  id: string
  cwd: string
  timestamp?: string
}

function readPiHeader(filePath: string): PiSessionHeader | undefined {
  try {
    const row = JSON.parse(readFirstLine(filePath)) as Record<string, unknown>
    if (row.type !== 'session' || typeof row.id !== 'string' || typeof row.cwd !== 'string') {
      return undefined
    }
    return {
      id: row.id,
      cwd: row.cwd,
      timestamp: typeof row.timestamp === 'string' ? row.timestamp : undefined,
    }
  } catch {
    return undefined
  }
}

function resolveConfiguredPath(value: string, agentSourceDir: string): string {
  const parentDir = path.dirname(agentSourceDir)
  const homeDir = path.basename(agentSourceDir) === 'agent' && path.basename(parentDir) === '.pi'
    ? path.dirname(parentDir)
    : os.homedir()
  if (value === '~') return homeDir
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(value)
}

function resolveSessionsDir(agentSourceDir: string): string {
  const settingsPath = path.join(agentSourceDir, 'settings.json')
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
      if (typeof settings.sessionDir === 'string' && settings.sessionDir.trim()) {
        return resolveConfiguredPath(settings.sessionDir.trim(), agentSourceDir)
      }
    } catch {
      // 无效 settings 时继续使用默认 sessions/。
    }
  }
  const nested = path.join(agentSourceDir, 'sessions')
  return fs.existsSync(nested) ? nested : agentSourceDir
}

function countToolCalls(content: unknown): number {
  if (!Array.isArray(content)) return 0
  return content.filter((part) => {
    if (!part || typeof part !== 'object') return false
    const type = (part as Record<string, unknown>).type
    return type === 'toolCall' || type === 'tool_use' || type === 'tool'
  }).length
}

export const piAdapter: AgentAdapter = {
  name: 'pi',

  async probe(agentSourceDir: string) {
    const sessionsDir = resolveSessionsDir(agentSourceDir)
    const matched = collectFilesRecursive(
      sessionsDir,
      (filePath) => filePath.endsWith('.jsonl'),
    ).some((filePath) => readPiHeader(filePath) !== undefined)
    return matched ? { matched: true } : { matched: false, reason: 'no Pi session JSONL' }
  },

  async discover(agentSourceDir: string): Promise<DiscoveredSession[]> {
    const sessions = new Map<string, DiscoveredSession>()
    const sessionsDir = resolveSessionsDir(agentSourceDir)
    for (const filePath of collectFilesRecursive(
      sessionsDir,
      (candidate) => candidate.endsWith('.jsonl'),
    )) {
      const header = readPiHeader(filePath)
      if (!header || sessions.has(header.id)) continue
      sessions.set(header.id, {
        id: header.id,
        agent: 'pi',
        sourcePath: filePath,
        sourceKind: 'jsonl',
        updatedAt: fileMtime(filePath),
        contentHash: fileHash(filePath),
      })
    }
    return [...sessions.values()]
  },

  async parse(discovered: DiscoveredSession): Promise<ParsedSession> {
    const parsed: ParsedSession = {
      agent: 'pi',
      sessionId: discovered.id,
      sourcePath: discovered.sourcePath,
      messageCount: 0,
      toolCallCount: 0,
      metadata: {},
    }
    if (!fs.existsSync(discovered.sourcePath)) return parsed

    const header = readPiHeader(discovered.sourcePath)
    if (header) parsed.metadata.cwd = header.cwd
    let firstTimestamp: string | undefined
    let lastTimestamp: string | undefined
    for (const row of readJsonlObjects(discovered.sourcePath)) {
      if (typeof row.timestamp === 'string') {
        firstTimestamp ??= row.timestamp
        lastTimestamp = row.timestamp
      }
      if (row.type !== 'message') continue
      const message = row.message as Record<string, unknown> | undefined
      if (message?.role === 'user' || message?.role === 'assistant') parsed.messageCount++
      if (message?.role === 'assistant') parsed.toolCallCount += countToolCalls(message.content)
    }
    if (firstTimestamp) parsed.firstTimestamp = firstTimestamp
    if (lastTimestamp) parsed.lastTimestamp = lastTimestamp
    return parsed
  },

  normalize: defaultNormalize,

  async extractProjectHints(discovered: DiscoveredSession): Promise<ProjectHint[]> {
    if (!fs.existsSync(discovered.sourcePath)) return []
    const header = readPiHeader(discovered.sourcePath)
    if (!header?.cwd) return []
    return [{
      kind: 'cwd',
      value: header.cwd,
      confidence: 0.9,
      agent: 'pi',
      source: 'metadata',
      locator: 'session.cwd',
    }]
  },
}
