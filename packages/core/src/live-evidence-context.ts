import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { throwIfAborted } from './abort.js'
import type {
  CoverageLedger,
  SessionEvidenceMode,
  SessionEvidenceReference,
} from './evidence-coverage.js'
import type {
  SessionSourceMessage,
  SessionSourceReadResult,
} from './session-source-reader.js'
import type { AgentName } from './types.js'

const CONTEXT_PREFIX = 'memory-manager-live-evidence-'
const DEFAULT_MAX_CHUNK_BYTES = 512 * 1024
const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1_000

export interface LiveEvidenceLocator {
  sessionId: string
  agent: AgentName
  messageIndex: number
  timestamp?: string
  sourceRevision: string
}

export interface EvidenceFact {
  id: string
  text: string
  kind: 'explicit' | 'inferred'
  locators: LiveEvidenceLocator[]
}

export interface SessionCapsule {
  sessionId: string
  agent: AgentName
  chunkIndex: number
  chunkCount: number
  summary: string
  facts: EvidenceFact[]
  relevant: boolean
}

export interface LiveEvidenceContextInput {
  runId: string
  mode: SessionEvidenceMode
  selected: SessionEvidenceReference[]
}

export interface LiveEvidenceContextOptions {
  parentDir?: string
  maxChunkBytes?: number
}

export interface CleanupLiveEvidenceContextsOptions {
  parentDir?: string
  now?: number
  maxAgeMs?: number
}

export interface LiveEvidenceSessionSource {
  sessionId: string
  agent: AgentName
  directory: string
  chunkCount: number
  chunkPaths: string[]
}

export interface LiveEvidenceContext {
  rootDir: string
  manifestPath: string
  coveragePath: string
  sourcesDir: string
  capsulesDir: string
  writeSessionChunks: (result: SessionSourceReadResult) => LiveEvidenceSessionSource
  writeCoverage: (coverage: CoverageLedger) => void
  writeCapsule: (capsule: SessionCapsule) => string
  cleanup: () => void
}

interface ManifestChunk {
  path: string
  bytes: number
  firstMessageIndex: number
  lastMessageIndex: number
}

interface ManifestSession {
  id: string
  agent: AgentName
  directory: string
  status: 'pending' | 'written'
  sourceRevision?: string
  changedDuringRun?: boolean
  chunks: ManifestChunk[]
}

interface LiveEvidenceManifest {
  version: 1
  runId: string
  mode: SessionEvidenceMode
  selected: number
  sessions: ManifestSession[]
}

interface RenderedMessage {
  messageIndex: number
  content: string
}

function referenceKey(reference: SessionEvidenceReference): string {
  return `${reference.agent}\0${reference.id}`
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  fs.chmodSync(filePath, 0o600)
}

function contextOwnerPid(name: string): number | undefined {
  const value = name.match(/^memory-manager-live-evidence-(\d+)-/)?.[1]
  if (!value) return undefined
  const pid = Number(value)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function cleanupStaleLiveEvidenceContexts(
  options: CleanupLiveEvidenceContextsOptions = {},
): void {
  const parentDir = options.parentDir ?? os.tmpdir()
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_STALE_AGE_MS
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error('live evidence stale age must be a non-negative number')
  }
  if (!fs.existsSync(parentDir)) return
  for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(CONTEXT_PREFIX)) continue
    const directory = path.join(parentDir, entry.name)
    try {
      const ownerPid = contextOwnerPid(entry.name)
      const expired = now - fs.statSync(directory).mtimeMs > maxAgeMs
      if (expired || (ownerPid !== undefined && !isProcessAlive(ownerPid))) {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    } catch {
      // Another cleanup may have removed the directory concurrently.
    }
  }
}

function renderMessage(
  result: SessionSourceReadResult,
  message: SessionSourceMessage,
  messageIndex: number,
): RenderedMessage {
  const locator: LiveEvidenceLocator = {
    sessionId: result.sessionId,
    agent: result.agent,
    messageIndex,
    ...(typeof message.timestamp === 'string' ? { timestamp: message.timestamp } : {}),
    sourceRevision: result.sourceRevision!.fingerprint,
  }
  return {
    messageIndex,
    content: [
      '<session_message>',
      `locator: ${JSON.stringify(locator)}`,
      `role: ${message.role}`,
      `content: ${JSON.stringify(message.content) ?? 'null'}`,
      '</session_message>',
      '',
    ].join('\n'),
  }
}

function partitionMessages(
  result: SessionSourceReadResult,
  maxChunkBytes: number,
): RenderedMessage[][] {
  const rendered = result.messages.map((message, index) =>
    renderMessage(result, message, index))
  const chunks: RenderedMessage[][] = []
  let current: RenderedMessage[] = []
  let currentBytes = 0
  for (const message of rendered) {
    const bytes = Buffer.byteLength(message.content, 'utf8')
    if (current.length > 0 && currentBytes + bytes > maxChunkBytes) {
      chunks.push(current)
      current = []
      currentBytes = 0
    }
    current.push(message)
    currentBytes += bytes
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export function createLiveEvidenceContext(
  input: LiveEvidenceContextInput,
  options: LiveEvidenceContextOptions = {},
): LiveEvidenceContext {
  if (!input.runId.trim()) throw new Error('live evidence run id is required')
  if (input.selected.length === 0) throw new Error('live evidence selected sessions must not be empty')
  const keys = input.selected.map(referenceKey)
  if (new Set(keys).size !== keys.length) {
    throw new Error('live evidence selected session references must be unique')
  }
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes <= 0) {
    throw new Error('live evidence chunk byte budget must be a positive integer')
  }

  const parentDir = options.parentDir ?? os.tmpdir()
  fs.mkdirSync(parentDir, { recursive: true })
  const runHash = crypto.createHash('sha256').update(input.runId).digest('hex').slice(0, 12)
  const rootDir = fs.mkdtempSync(path.join(parentDir, `${CONTEXT_PREFIX}${process.pid}-${runHash}-`))
  const sourcesDir = path.join(rootDir, 'sources')
  const capsulesDir = path.join(rootDir, 'capsules')
  const manifestPath = path.join(rootDir, 'manifest.json')
  const coveragePath = path.join(rootDir, 'coverage.json')
  const manifest: LiveEvidenceManifest = {
    version: 1,
    runId: input.runId,
    mode: input.mode,
    selected: input.selected.length,
    sessions: input.selected.map((reference, index) => ({
      id: reference.id,
      agent: reference.agent,
      directory: path.join('sources', `session-${String(index + 1).padStart(4, '0')}`),
      status: 'pending',
      chunks: [],
    })),
  }
  try {
    fs.chmodSync(rootDir, 0o700)
    fs.mkdirSync(sourcesDir, { mode: 0o700 })
    fs.mkdirSync(capsulesDir, { mode: 0o700 })
    writePrivateJson(manifestPath, manifest)
  } catch (error) {
    fs.rmSync(rootDir, { recursive: true, force: true })
    throw error
  }
  const sessionIndexes = new Map(keys.map((key, index) => [key, index]))

  let cleaned = false
  function cleanup(): void {
    if (cleaned) return
    cleaned = true
    process.removeListener('exit', cleanup)
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
  process.once('exit', cleanup)

  function writeSessionChunks(result: SessionSourceReadResult): LiveEvidenceSessionSource {
    if (result.status !== 'readable' || !result.sourceRevision) {
      throw new Error(`session ${result.sessionId} is not readable with a source revision`)
    }
    const index = sessionIndexes.get(referenceKey({ agent: result.agent, id: result.sessionId }))
    if (index === undefined) throw new Error(`session ${result.sessionId} is not selected`)
    const sessionManifest = manifest.sessions[index]
    if (sessionManifest.status === 'written') {
      throw new Error(`session ${result.sessionId} chunks are already written`)
    }
    const directory = path.join(rootDir, sessionManifest.directory)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const chunks = partitionMessages(result, maxChunkBytes)
    const chunkPaths = chunks.map((messages, chunkIndex) => {
      const filePath = path.join(
        directory,
        `chunk-${String(chunkIndex + 1).padStart(4, '0')}.md`,
      )
      const content = `# Session Evidence\n\n${messages.map((message) => message.content).join('')}`
      fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 })
      sessionManifest.chunks.push({
        path: path.relative(rootDir, filePath),
        bytes: Buffer.byteLength(content, 'utf8'),
        firstMessageIndex: messages[0].messageIndex,
        lastMessageIndex: messages[messages.length - 1].messageIndex,
      })
      return filePath
    })
    sessionManifest.status = 'written'
    sessionManifest.sourceRevision = result.sourceRevision.fingerprint
    sessionManifest.changedDuringRun = result.sourceRevision.changedDuringRun
    writePrivateJson(manifestPath, manifest)
    return {
      sessionId: result.sessionId,
      agent: result.agent,
      directory,
      chunkCount: chunkPaths.length,
      chunkPaths,
    }
  }

  function writeCoverage(coverage: CoverageLedger): void {
    if (coverage.runId !== input.runId) {
      throw new Error('coverage run id does not match live evidence context')
    }
    writePrivateJson(coveragePath, coverage)
  }

  function writeCapsule(capsule: SessionCapsule): string {
    const index = sessionIndexes.get(referenceKey({ agent: capsule.agent, id: capsule.sessionId }))
    if (index === undefined) throw new Error(`session ${capsule.sessionId} is not selected`)
    const expectedChunks = manifest.sessions[index].chunks.length
    if (capsule.chunkCount !== expectedChunks) {
      throw new Error(`session ${capsule.sessionId} capsule chunk count does not match manifest`)
    }
    if (
      !Number.isInteger(capsule.chunkIndex)
      || capsule.chunkIndex < 0
      || capsule.chunkIndex >= expectedChunks
    ) {
      throw new Error(`session ${capsule.sessionId} capsule chunk index is invalid`)
    }
    const filePath = path.join(
      capsulesDir,
      `session-${String(index + 1).padStart(4, '0')}-${String(capsule.chunkIndex + 1).padStart(4, '0')}.json`,
    )
    writePrivateJson(filePath, capsule)
    return filePath
  }

  return {
    rootDir,
    manifestPath,
    coveragePath,
    sourcesDir,
    capsulesDir,
    writeSessionChunks,
    writeCoverage,
    writeCapsule,
    cleanup,
  }
}

export async function withLiveEvidenceContext<T>(
  input: LiveEvidenceContextInput,
  options: LiveEvidenceContextOptions,
  task: (context: LiveEvidenceContext) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal)
  const context = createLiveEvidenceContext(input, options)
  try {
    throwIfAborted(signal)
    return await task(context)
  } finally {
    context.cleanup()
  }
}
