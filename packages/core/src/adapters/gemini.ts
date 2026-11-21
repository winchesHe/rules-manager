import fs from 'node:fs'
import path from 'node:path'
import type {
  AgentAdapter,
  DiscoveredSession,
  ParsedSession,
  ProjectHint,
} from '../types.js'
import { readGeminiSession } from '../gemini-session.js'
import {
  collectFilesRecursive,
  defaultNormalize,
  fileHash,
  fileMtime,
} from './shared.js'

function sessionFiles(agentSourceDir: string): string[] {
  return collectFilesRecursive(
    path.join(agentSourceDir, 'tmp'),
    (filePath) => path.basename(filePath).startsWith('session-')
      && ['.jsonl', '.json'].includes(path.extname(filePath).toLowerCase()),
  )
}

function hasAbsolutePath(value: string | undefined): value is string {
  return Boolean(value && path.isAbsolute(value))
}

function sessionIdFromFilePath(filePath: string): string {
  return path.basename(filePath).replace(/^session-/, '').replace(/\.(jsonl|json)$/i, '')
}

export const geminiAdapter: AgentAdapter = {
  name: 'gemini',

  async probe(agentSourceDir: string) {
    return sessionFiles(agentSourceDir).length > 0
      ? { matched: true }
      : { matched: false, reason: 'no Gemini CLI session JSONL under tmp/*/chats' }
  },

  async discover(agentSourceDir: string): Promise<DiscoveredSession[]> {
    const sessions = new Map<string, DiscoveredSession>()
    for (const filePath of sessionFiles(agentSourceDir)) {
      let session
      try {
        session = readGeminiSession(filePath)
      } catch {
        // 仍发现该标准命名文件，交给 parse 阶段失败并让 scanner 记录错误。
      }
      const id = session?.sessionId ?? sessionIdFromFilePath(filePath)
      if (!id) continue
      const discovered: DiscoveredSession = {
        id,
        agent: 'gemini',
        sourcePath: filePath,
        sourceKind: path.extname(filePath).slice(1).toLowerCase(),
        updatedAt: fileMtime(filePath),
        contentHash: fileHash(filePath),
      }
      const existing = sessions.get(discovered.id)
      if (!existing || discovered.updatedAt > existing.updatedAt) {
        sessions.set(discovered.id, discovered)
      }
    }
    return [...sessions.values()]
  },

  async parse(discovered: DiscoveredSession): Promise<ParsedSession> {
    const session = readGeminiSession(discovered.sourcePath)
    const messages = session.messages.filter(
      (message) => message.type === 'user' || message.type === 'gemini',
    )
    const parsed: ParsedSession = {
      agent: 'gemini',
      sessionId: session.sessionId ?? discovered.id,
      sourcePath: discovered.sourcePath,
      messageCount: messages.length,
      toolCallCount: messages.reduce((count, message) => {
        return count + (Array.isArray(message.toolCalls) ? message.toolCalls.length : 0)
      }, 0),
      metadata: {
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(session.gitRoot ? { gitRoot: session.gitRoot } : {}),
        ...(session.branch ? { branch: session.branch } : {}),
        ...(session.headCommit ? { headCommit: session.headCommit } : {}),
      },
    }
    const timestamps = messages
      .map((message) => message.timestamp)
      .filter((timestamp): timestamp is string => typeof timestamp === 'string')
    parsed.firstTimestamp = timestamps[0] ?? session.startTime
    parsed.lastTimestamp = session.lastUpdated ?? timestamps.at(-1)
    return parsed
  },

  normalize: defaultNormalize,

  async extractProjectHints(discovered: DiscoveredSession): Promise<ProjectHint[]> {
    const session = readGeminiSession(discovered.sourcePath)
    const hints: ProjectHint[] = []
    if (hasAbsolutePath(session.cwd)) {
      hints.push({
        kind: 'cwd', value: session.cwd, confidence: 0.9,
        agent: 'gemini', source: 'metadata', locator: 'session.cwd',
      })
    }
    if (hasAbsolutePath(session.gitRoot)) {
      hints.push({
        kind: 'git_root', value: session.gitRoot, confidence: 0.95,
        agent: 'gemini', source: 'metadata', locator: 'session.gitRoot',
      })
    }
    return hints
  },
}
