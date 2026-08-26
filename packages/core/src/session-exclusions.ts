import fs from 'node:fs'
import path from 'node:path'
import type { AgentName } from './types.js'
import { resolveWorkspace } from './workspace.js'

const INTERNAL_EXCLUSIONS_FILE = 'internal-session-exclusions.json'

export interface SessionExclusionReference {
  agent: AgentName
  id: string
}

interface InternalExclusionFile {
  version: 1
  sessions: Array<SessionExclusionReference & { recordedAt: string }>
}

function key(reference: SessionExclusionReference): string {
  return `${reference.agent}\0${reference.id}`
}

function internalPath(chatsDir: string): string {
  return path.join(chatsDir, INTERNAL_EXCLUSIONS_FILE)
}

function readInternal(chatsDir: string): InternalExclusionFile['sessions'] {
  try {
    const value = JSON.parse(fs.readFileSync(internalPath(chatsDir), 'utf8')) as InternalExclusionFile
    if (value.version !== 1 || !Array.isArray(value.sessions)) return []
    return value.sessions.filter((item) =>
      item && typeof item.id === 'string' && typeof item.agent === 'string'
      && ['claude', 'codex', 'opencode', 'pi'].includes(item.agent)
      && typeof item.recordedAt === 'string')
  } catch {
    return []
  }
}

export function recordInternalSessionExclusion(
  chatsDir: string,
  reference: SessionExclusionReference,
  recordedAt: string,
): void {
  fs.mkdirSync(chatsDir, { recursive: true })
  const sessions = readInternal(chatsDir)
  if (sessions.some((item) => key(item) === key(reference))) return
  const target = internalPath(chatsDir)
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify({
    version: 1,
    sessions: [...sessions, { ...reference, recordedAt }],
  } satisfies InternalExclusionFile, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, target)
}

export function collectSessionExclusions(
  chatsDir: string,
  currentThreadId?: string,
): SessionExclusionReference[] {
  const references = new Map(readInternal(chatsDir).map((item) => [key(item), {
    agent: item.agent,
    id: item.id,
  }]))
  if (!fs.existsSync(chatsDir)) return [...references.values()]
  for (const entry of fs.readdirSync(chatsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const thread = JSON.parse(fs.readFileSync(path.join(chatsDir, entry.name, 'thread.json'), 'utf8')) as {
        version?: unknown
        id?: unknown
        provider?: unknown
        origin?: unknown
        nativeSessionId?: unknown
      }
      const shouldExclude = thread.version === 2
        && (thread.origin === 'rules' || thread.id === currentThreadId)
      if (!shouldExclude || typeof thread.nativeSessionId !== 'string') continue
      if (!['claude', 'codex', 'opencode', 'pi'].includes(String(thread.provider))) continue
      const reference = {
        agent: thread.provider as AgentName,
        id: thread.nativeSessionId,
      }
      references.set(key(reference), reference)
    } catch {
      continue
    }
  }
  return [...references.values()]
}

export function collectScannedSessionExclusionKeys(homeDir?: string): Set<string> {
  return new Set(collectSessionExclusions(resolveWorkspace(homeDir).chatsDir).map(key))
}

export function sessionExclusionKey(reference: SessionExclusionReference): string {
  return key(reference)
}
