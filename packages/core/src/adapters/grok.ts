import fs from 'node:fs'
import path from 'node:path'
import type {
  AgentAdapter,
  DiscoveredSession,
  ParsedSession,
  ProjectHint,
} from '../types.js'
import {
  grokSessionId,
  grokSourcePath,
  hashGrokSession,
  isGrokSessionDirectory,
  readGrokSession,
} from '../grok-session.js'
import {
  collectFilesRecursive,
  defaultNormalize,
  fileMtime,
} from './shared.js'

function sessionDirectories(agentSourceDir: string): string[] {
  const sessionsRoot = path.join(agentSourceDir, 'sessions')
  const logs = collectFilesRecursive(
    sessionsRoot,
    (filePath) => ['updates.jsonl', 'chat_history.jsonl'].includes(path.basename(filePath)),
  )
  return [...new Set(logs.map((filePath) => path.dirname(filePath)))]
    .filter(isGrokSessionDirectory)
    .sort()
}

function hasAbsolutePath(value: string | undefined): value is string {
  return Boolean(value && path.isAbsolute(value))
}

export const grokAdapter: AgentAdapter = {
  name: 'grok',

  async probe(agentSourceDir: string) {
    return sessionDirectories(agentSourceDir).length > 0
      ? { matched: true }
      : { matched: false, reason: 'no Grok Build session directories under sessions/' }
  },

  async discover(agentSourceDir: string): Promise<DiscoveredSession[]> {
    return sessionDirectories(agentSourceDir).flatMap((directory) => {
      const id = grokSessionId(directory)
      if (!id) return []
      const sourcePath = grokSourcePath(directory)
      if (!fs.existsSync(sourcePath)) return []
      const summaryPath = path.join(directory, 'summary.json')
      return [{
        id,
        agent: 'grok',
        sourcePath,
        sourceKind: path.basename(sourcePath) === 'updates.jsonl'
          ? 'grok-updates-jsonl'
          : 'grok-chat-history-jsonl',
        updatedAt: fileMtime(fs.existsSync(summaryPath) ? summaryPath : sourcePath),
        contentHash: hashGrokSession(sourcePath),
      }]
    })
  },

  async parse(discovered: DiscoveredSession): Promise<ParsedSession> {
    const session = readGrokSession(discovered.sourcePath, discovered.id)
    const parsed: ParsedSession = {
      agent: 'grok',
      sessionId: session.sessionId,
      sourcePath: discovered.sourcePath,
      messageCount: session.events.filter((event) => event.kind === 'message').length,
      toolCallCount: session.events.filter((event) => event.kind === 'tool_call').length,
      metadata: {
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(session.gitRoot ? { gitRoot: session.gitRoot } : {}),
        ...(session.gitRemote ? { gitRemote: session.gitRemote } : {}),
        ...(session.branch ? { branch: session.branch } : {}),
        ...(session.headCommit ? { headCommit: session.headCommit } : {}),
      },
    }
    const timestamps = session.events
      .map((event) => event.timestamp)
      .filter((timestamp): timestamp is string => typeof timestamp === 'string')
    parsed.firstTimestamp = timestamps[0]
    parsed.lastTimestamp = session.updatedAt ?? timestamps.at(-1)
    return parsed
  },

  normalize: defaultNormalize,

  async extractProjectHints(discovered: DiscoveredSession): Promise<ProjectHint[]> {
    const session = readGrokSession(discovered.sourcePath, discovered.id)
    const hints: ProjectHint[] = []
    if (hasAbsolutePath(session.cwd)) {
      hints.push({
        kind: 'cwd', value: session.cwd, confidence: 0.9,
        agent: 'grok', source: 'metadata', locator: 'summary.json.info.cwd',
      })
    }
    if (hasAbsolutePath(session.gitRoot)) {
      hints.push({
        kind: 'git_root', value: session.gitRoot, confidence: 0.95,
        agent: 'grok', source: 'metadata', locator: 'summary.json.git_root_dir',
      })
    }
    if (session.gitRemote) {
      hints.push({
        kind: 'git_remote', value: session.gitRemote, confidence: 0.9,
        agent: 'grok', source: 'metadata', locator: 'summary.json.git_remotes[0]',
      })
    }
    if (session.branch) {
      hints.push({
        kind: 'branch', value: session.branch, confidence: 0.8,
        agent: 'grok', source: 'metadata', locator: 'summary.json.head_branch',
      })
    }
    return hints
  },
}
