import fs from 'node:fs'
import path from 'node:path'
import type {
  AgentAdapter,
  DiscoveredSession,
  ParsedSession,
  ProjectHint,
} from '../types.js'
import {
  defaultNormalize,
  fileHash,
  fileMtime,
  isUuid,
  readFirstLine,
  readJsonlObjects,
  readYamlObject,
} from './shared.js'

function asTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' && value ? value : undefined
}

function workspaceFileFor(sourcePath: string): string {
  return path.join(path.dirname(sourcePath), 'workspace.yaml')
}

function readWorkspaceMetadata(sourcePath: string): Record<string, unknown> {
  const workspaceFile = path.basename(sourcePath) === 'workspace.yaml'
    ? sourcePath
    : workspaceFileFor(sourcePath)
  return readYamlObject(workspaceFile)
}

function readProjectContext(discovered: DiscoveredSession): Record<string, unknown> {
  let context: Record<string, unknown> = {}
  if (discovered.sourceKind !== 'yaml') {
    try {
      const first = JSON.parse(readFirstLine(discovered.sourcePath)) as Record<string, unknown>
      const data = first.data as Record<string, unknown> | undefined
      context = (data?.context as Record<string, unknown> | undefined) ?? {}
    } catch {
      // workspace.yaml 仍可提供项目元数据。
    }
  }
  const workspace = readWorkspaceMetadata(discovered.sourcePath)
  return {
    ...context,
    cwd: workspace.cwd ?? context.cwd,
    gitRoot: workspace.git_root ?? context.gitRoot,
    branch: workspace.branch ?? context.branch,
  }
}

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

  async parse(discovered: DiscoveredSession): Promise<ParsedSession> {
    const parsed: ParsedSession = {
      agent: 'copilot',
      sessionId: discovered.id,
      sourcePath: discovered.sourcePath,
      messageCount: 0,
      toolCallCount: 0,
      metadata: {},
    }
    if (!fs.existsSync(discovered.sourcePath)) return parsed

    const objs = discovered.sourceKind === 'yaml' ? [] : readJsonlObjects(discovered.sourcePath)
    let firstTs: string | undefined
    let lastTs: string | undefined

    for (const obj of objs) {
      if (typeof obj.timestamp === 'string') {
        if (!firstTs) firstTs = obj.timestamp
        lastTs = obj.timestamp
      }
      if (obj.type === 'user.message' || obj.type === 'assistant.message') {
        parsed.messageCount++
      } else if (obj.type === 'tool.execution_start') {
        parsed.toolCallCount++
      } else if (obj.type === 'session.start') {
        const data = obj.data as Record<string, unknown> | undefined
        const ctx = data?.context as Record<string, unknown> | undefined
        if (typeof ctx?.cwd === 'string') parsed.metadata.cwd = ctx.cwd
        if (typeof ctx?.gitRoot === 'string') parsed.metadata.gitRoot = ctx.gitRoot
        if (typeof ctx?.branch === 'string') parsed.metadata.branch = ctx.branch
        if (typeof ctx?.headCommit === 'string') parsed.metadata.headCommit = ctx.headCommit
      }
    }

    const workspace = readWorkspaceMetadata(discovered.sourcePath)
    if (typeof workspace.cwd === 'string') parsed.metadata.cwd = workspace.cwd
    if (typeof workspace.git_root === 'string') parsed.metadata.gitRoot = workspace.git_root
    if (typeof workspace.branch === 'string') parsed.metadata.branch = workspace.branch
    firstTs ??= asTimestamp(workspace.created_at)
    lastTs ??= asTimestamp(workspace.updated_at)

    if (firstTs) parsed.firstTimestamp = firstTs
    if (lastTs) parsed.lastTimestamp = lastTs
    return parsed
  },

  normalize: defaultNormalize,

  async extractProjectHints(discovered: DiscoveredSession): Promise<ProjectHint[]> {
    const hints: ProjectHint[] = []
    if (!fs.existsSync(discovered.sourcePath)) return hints

    try {
      const ctx = readProjectContext(discovered)
      const locatorPrefix = discovered.sourceKind === 'yaml' ? 'workspace' : 'session.start'

      if (typeof ctx.gitRoot === 'string' && ctx.gitRoot) {
        hints.push({
          kind: 'git_root',
          value: ctx.gitRoot,
          confidence: 0.95,
          agent: 'copilot',
          source: 'metadata',
          locator: locatorPrefix === 'workspace'
            ? 'workspace.git_root'
            : 'session.start.data.context.gitRoot',
        })
      }
      if (typeof ctx.cwd === 'string' && ctx.cwd) {
        hints.push({
          kind: 'cwd',
          value: ctx.cwd,
          confidence: 0.9,
          agent: 'copilot',
          source: 'metadata',
          locator: locatorPrefix === 'workspace'
            ? 'workspace.cwd'
            : 'session.start.data.context.cwd',
        })
      }
      if (typeof ctx.branch === 'string' && ctx.branch) {
        hints.push({
          kind: 'branch',
          value: ctx.branch,
          confidence: 0.2,
          agent: 'copilot',
          source: 'metadata',
          locator: locatorPrefix === 'workspace'
            ? 'workspace.branch'
            : 'session.start.data.context.branch',
        })
      }
    } catch {
      // workspace 元数据损坏时返回已有 hints（可能为空）。
    }
    return hints
  },

  async discover(agentSourceDir: string): Promise<DiscoveredSession[]> {
    const sessionStateDir = path.join(agentSourceDir, 'session-state')
    if (!fs.existsSync(sessionStateDir)) return []

    const sessions: DiscoveredSession[] = []

    for (const entry of fs.readdirSync(sessionStateDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isUuid(entry.name)) continue
      const sessionDir = path.join(sessionStateDir, entry.name)

      const eventsFile = path.join(sessionDir, 'events.jsonl')
      const workspaceFile = path.join(sessionDir, 'workspace.yaml')
      const sourcePath = fs.existsSync(eventsFile) ? eventsFile : workspaceFile
      if (!fs.existsSync(sourcePath)) continue

      let updatedAt = fileMtime(sourcePath)
      try {
        const metadata = readYamlObject(workspaceFile)
        updatedAt = asTimestamp(metadata.updated_at) ?? updatedAt
      } catch {
        // use mtime
      }

      sessions.push({
        id: entry.name,
        agent: 'copilot',
        sourcePath,
        sourceKind: sourcePath === eventsFile ? 'jsonl' : 'yaml',
        updatedAt,
        contentHash: fileHash(sourcePath),
      })
    }

    return sessions
  },
}
