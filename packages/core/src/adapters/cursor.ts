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
  readJsonlObjects,
} from './shared.js'

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

  async parse(discovered: DiscoveredSession): Promise<ParsedSession> {
    const parsed: ParsedSession = {
      agent: 'cursor',
      sessionId: discovered.id,
      sourcePath: discovered.sourcePath,
      messageCount: 0,
      toolCallCount: 0,
      metadata: {},
    }
    if (!fs.existsSync(discovered.sourcePath)) return parsed

    for (const obj of readJsonlObjects(discovered.sourcePath)) {
      if (obj.role === 'user' || obj.role === 'assistant') parsed.messageCount++
      // cursor jsonl 没有顶层 timestamp / cwd —— 无可抽元数据
      const message = obj.message as Record<string, unknown> | undefined
      const content = message?.content as Array<Record<string, unknown>> | undefined
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === 'tool_use') parsed.toolCallCount++
        }
      }
    }
    return parsed
  },

  normalize: defaultNormalize,

  async extractProjectHints(discovered: DiscoveredSession): Promise<ProjectHint[]> {
    const hints: ProjectHint[] = []
    // cursor jsonl 没有 cwd / gitRoot 元数据，只能依赖目录编码。
    // sourcePath = .../projects/<encoded>/agent-transcripts/<session>/<transcript>.jsonl
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
        if (!sessionEntry.isDirectory()) continue

        const sessionDir = path.join(transcriptsDir, sessionEntry.name)
        const preferredFile = path.join(sessionDir, `${sessionEntry.name}.jsonl`)
        const sessionFile = fs.existsSync(preferredFile)
          ? preferredFile
          : fs
              .readdirSync(sessionDir, { withFileTypes: true })
              .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
              .map((entry) => path.join(sessionDir, entry.name))
              .sort()[0]
        if (!sessionFile) continue

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
