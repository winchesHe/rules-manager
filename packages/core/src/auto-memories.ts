import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { parseCodexProjectMemories } from './codex-memory-parser.js'

export const AUTO_MEMORY_AGENTS = ['claude', 'codex'] as const

export type AutoMemoryAgent = (typeof AUTO_MEMORY_AGENTS)[number]

export interface AutoMemorySource {
  id: string
  agent: AutoMemoryAgent
  scope: 'project' | 'global'
  path: string
  format: 'markdown'
  status: 'present' | 'missing'
  discoveredFrom: 'filesystem' | 'default' | 'environment'
  note?: string
  projectPath?: string
  taskGroupCount?: number
  modifiedAt: string | null
  sizeBytes: number
}

export interface AutoMemoryError {
  agent: AutoMemoryAgent
  path: string
  message: string
}

export interface AutoMemoryListResult {
  agent: AutoMemoryAgent | null
  count: number
  sources: AutoMemorySource[]
  errors: AutoMemoryError[]
}

export interface AutoMemoryReadResult {
  source: AutoMemorySource
  content: string
}

export interface AutoMemoryListOptions {
  agent?: AutoMemoryAgent
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

const MAX_MEMORY_BYTES = 1024 * 1024
const MAX_CLAUDE_SESSION_METADATA_BYTES = 1024 * 1024
const MAX_CLAUDE_SESSION_FILES = 24

function configRoot(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  variable: string,
  fallback: string,
): { root: string; discoveredFrom: 'default' | 'environment' } {
  const configured = env[variable]
  if (configured) {
    return { root: path.resolve(configured), discoveredFrom: 'environment' }
  }
  return { root: path.resolve(homeDir, fallback), discoveredFrom: 'default' }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function inspectSource(
  source: Omit<AutoMemorySource, 'status' | 'modifiedAt' | 'sizeBytes'>,
): AutoMemorySource {
  try {
    const stat = fs.statSync(source.path)
    if (!stat.isFile()) {
      return { ...source, status: 'missing', modifiedAt: null, sizeBytes: 0 }
    }
    return {
      ...source,
      status: 'present',
      modifiedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    }
  } catch {
    return { ...source, status: 'missing', modifiedAt: null, sizeBytes: 0 }
  }
}

function readClaudeSessionProjectPaths(sessionPath: string): string[] {
  let handle: number | null = null
  try {
    handle = fs.openSync(sessionPath, 'r')
    const stat = fs.fstatSync(handle)
    const bytesToRead = Math.min(stat.size, MAX_CLAUDE_SESSION_METADATA_BYTES)
    if (bytesToRead === 0) return []
    const buffer = Buffer.allocUnsafe(bytesToRead)
    const bytesRead = fs.readSync(handle, buffer, 0, bytesToRead, 0)
    const prefix = buffer.subarray(0, bytesRead).toString('utf8')
    const paths = new Set<string>()
    const cwdFields = prefix.matchAll(/"cwd"\s*:\s*("(?:\\.|[^"\\])*")/g)
    for (const match of cwdFields) {
      try {
        const cwd = JSON.parse(match[1]) as unknown
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd === '/') continue
        paths.add(path.normalize(cwd))
      } catch {
        // A truncated JSON string is not project-path evidence.
      }
    }
    return [...paths]
  } catch {
    return []
  } finally {
    if (handle !== null) fs.closeSync(handle)
  }
}

function discoverClaudeProjectPath(projectDirectory: string): string | undefined {
  let sessionFiles: Array<{ path: string; modifiedAt: number }> = []
  try {
    sessionFiles = fs.readdirSync(projectDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => {
        const sessionPath = path.join(projectDirectory, entry.name)
        return { path: sessionPath, modifiedAt: fs.statSync(sessionPath).mtimeMs }
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, MAX_CLAUDE_SESSION_FILES)
  } catch {
    return undefined
  }

  const candidates = new Set<string>()
  for (const session of sessionFiles) {
    for (const projectPath of readClaudeSessionProjectPaths(session.path)) {
      candidates.add(projectPath)
      if (candidates.size > 1) return undefined
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined
}

function listClaudeSources(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): { sources: AutoMemorySource[]; errors: AutoMemoryError[] } {
  const config = configRoot(homeDir, env, 'CLAUDE_CONFIG_DIR', '.claude')
  const projectsPath = path.join(config.root, 'projects')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(projectsPath, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return { sources: [], errors: [] }
    return {
      sources: [],
      errors: [{ agent: 'claude', path: projectsPath, message: errorMessage(error) }],
    }
  }

  const sources: AutoMemorySource[] = []
  const errors: AutoMemoryError[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const projectDirectory = path.join(projectsPath, entry.name)
    const memoryPath = path.join(projectsPath, entry.name, 'memory', 'MEMORY.md')
    try {
      const stat = fs.statSync(memoryPath)
      if (!stat.isFile()) continue
      const projectPath = discoverClaudeProjectPath(projectDirectory)
      sources.push({
        id: `project:${entry.name}`,
        agent: 'claude',
        scope: 'project',
        path: memoryPath,
        format: 'markdown',
        status: 'present',
        discoveredFrom: config.discoveredFrom === 'environment' ? 'environment' : 'filesystem',
        ...(projectPath ? { projectPath } : {}),
        modifiedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
      })
    } catch (error) {
      if (!isMissing(error)) {
        errors.push({ agent: 'claude', path: memoryPath, message: errorMessage(error) })
      }
    }
  }
  return { sources, errors }
}

function codexSource(homeDir: string, env: NodeJS.ProcessEnv): AutoMemorySource {
  const config = configRoot(homeDir, env, 'CODEX_HOME', '.codex')
  return inspectSource({
    id: 'memory',
    agent: 'codex',
    scope: 'global',
    path: path.join(config.root, 'memories', 'MEMORY.md'),
    format: 'markdown',
    discoveredFrom: config.discoveredFrom,
    note: 'Codex 本地 Memory 是跨对话合并来源；项目视图由 applies_to.cwd 从该文件派生。',
  })
}

function codexProjectId(projectPath: string): string {
  return `project:${crypto.createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}`
}

function listCodexSources(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): { sources: AutoMemorySource[]; errors: AutoMemoryError[] } {
  const globalSource = codexSource(homeDir, env)
  if (globalSource.status === 'missing') return { sources: [globalSource], errors: [] }

  try {
    const { content, stat } = readStableMemoryFile(globalSource.path)
    const projectSources = parseCodexProjectMemories(content).map((project) => ({
      id: codexProjectId(project.projectPath),
      agent: 'codex' as const,
      scope: 'project' as const,
      path: globalSource.path,
      format: 'markdown' as const,
      status: 'present' as const,
      discoveredFrom: globalSource.discoveredFrom,
      note: '此项目视图由 Codex 合并 MEMORY.md 中的 applies_to.cwd 派生，不是独立文件。',
      projectPath: project.projectPath,
      taskGroupCount: project.taskGroupCount,
      modifiedAt: stat.mtime.toISOString(),
      sizeBytes: Buffer.byteLength(project.content),
    }))
    return { sources: [globalSource, ...projectSources], errors: [] }
  } catch (error) {
    return {
      sources: [globalSource],
      errors: [{ agent: 'codex', path: globalSource.path, message: errorMessage(error) }],
    }
  }
}

function compareSources(left: AutoMemorySource, right: AutoMemorySource): number {
  return left.agent.localeCompare(right.agent, 'en')
    || Number(left.scope === 'project') - Number(right.scope === 'project')
    || (left.projectPath ?? '').localeCompare(right.projectPath ?? '', 'en')
    || left.id.localeCompare(right.id, 'en')
    || left.path.localeCompare(right.path, 'en')
}

export function isAutoMemoryAgent(value: string): value is AutoMemoryAgent {
  return AUTO_MEMORY_AGENTS.includes(value as AutoMemoryAgent)
}

export function listAutoMemorySources(
  options: AutoMemoryListOptions = {},
): AutoMemoryListResult {
  const homeDir = path.resolve(options.homeDir ?? os.homedir())
  const env = options.env ?? process.env
  const sources: AutoMemorySource[] = []
  const errors: AutoMemoryError[] = []

  if (!options.agent || options.agent === 'claude') {
    const claude = listClaudeSources(homeDir, env)
    sources.push(...claude.sources)
    errors.push(...claude.errors)
  }
  if (!options.agent || options.agent === 'codex') {
    const codex = listCodexSources(homeDir, env)
    sources.push(...codex.sources)
    errors.push(...codex.errors)
  }

  sources.sort(compareSources)
  return {
    agent: options.agent ?? null,
    count: sources.length,
    sources,
    errors,
  }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
}

function readStableMemoryFile(sourcePath: string): { content: string; stat: fs.Stats } {
  const before = fs.statSync(sourcePath)
  if (!before.isFile()) throw new Error(`Agent Memory 来源不是文件：${sourcePath}`)
  if (before.size > MAX_MEMORY_BYTES) {
    throw new Error(`Agent Memory 文件超过 1 MiB：${sourcePath}`)
  }
  const contentBuffer = fs.readFileSync(sourcePath)
  const after = fs.statSync(sourcePath)
  if (!sameFile(before, after)) {
    throw new Error(`Agent Memory 在读取期间发生变化：${sourcePath}`)
  }

  try {
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(contentBuffer),
      stat: before,
    }
  } catch {
    throw new Error(`Agent Memory 不是有效 UTF-8：${sourcePath}`)
  }
}

export function readAutoMemorySource(
  agent: AutoMemoryAgent,
  memoryId?: string,
  options: Omit<AutoMemoryListOptions, 'agent'> = {},
): AutoMemoryReadResult {
  const homeDir = path.resolve(options.homeDir ?? os.homedir())
  const env = options.env ?? process.env
  let source: AutoMemorySource | undefined

  if (agent === 'codex' && (memoryId === undefined || memoryId === 'memory')) {
    source = codexSource(homeDir, env)
  } else {
    const result = listAutoMemorySources({ homeDir, env, agent })
    const presentSources = result.sources.filter((candidate) => candidate.status === 'present')
    if (memoryId !== undefined) {
      source = result.sources.find((candidate) => candidate.id === memoryId)
      if (!source) throw new Error(`未知的 Agent Memory：${agent}/${memoryId}`)
    } else if (presentSources.length === 1) {
      source = presentSources[0]
    } else if (presentSources.length === 0) {
      throw new Error(`没有可读取的 Agent Memory：${agent}`)
    } else {
      throw new Error(`存在多个 Agent Memory，请先选择 memory id：${agent}`)
    }
  }

  if (source.status === 'missing') {
    throw new Error(`Agent Memory 尚未生成：${agent}/${source.id}`)
  }

  const memory = readStableMemoryFile(source.path)
  let content = memory.content
  if (source.agent === 'codex' && source.scope === 'project') {
    const project = parseCodexProjectMemories(content).find(
      (candidate) => candidate.projectPath === source?.projectPath,
    )
    if (!project) throw new Error(`Codex 项目 Memory 已发生变化：${source.projectPath}`)
    content = project.content
  }

  return {
    source: {
      ...source,
      modifiedAt: memory.stat.mtime.toISOString(),
      sizeBytes: Buffer.byteLength(content),
    },
    content,
  }
}
