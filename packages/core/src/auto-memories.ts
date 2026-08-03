import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TextDecoder } from 'node:util'

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
    const memoryPath = path.join(projectsPath, entry.name, 'memory', 'MEMORY.md')
    try {
      const stat = fs.statSync(memoryPath)
      if (!stat.isFile()) continue
      sources.push({
        id: `project:${entry.name}`,
        agent: 'claude',
        scope: 'project',
        path: memoryPath,
        format: 'markdown',
        status: 'present',
        discoveredFrom: config.discoveredFrom === 'environment' ? 'environment' : 'filesystem',
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
    note: 'Codex 本地 Memory 是跨对话合并来源，不提供稳定的按项目文件映射。',
  })
}

function compareSources(left: AutoMemorySource, right: AutoMemorySource): number {
  return left.agent.localeCompare(right.agent, 'en')
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
    sources.push(codexSource(homeDir, env))
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

export function readAutoMemorySource(
  agent: AutoMemoryAgent,
  memoryId?: string,
  options: Omit<AutoMemoryListOptions, 'agent'> = {},
): AutoMemoryReadResult {
  const result = listAutoMemorySources({ ...options, agent })
  const presentSources = result.sources.filter((source) => source.status === 'present')
  let source: AutoMemorySource | undefined

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

  if (source.status === 'missing') {
    throw new Error(`Agent Memory 尚未生成：${agent}/${source.id}`)
  }

  const before = fs.statSync(source.path)
  if (!before.isFile()) throw new Error(`Agent Memory 来源不是文件：${source.path}`)
  if (before.size > MAX_MEMORY_BYTES) {
    throw new Error(`Agent Memory 文件超过 1 MiB：${source.path}`)
  }
  const contentBuffer = fs.readFileSync(source.path)
  const after = fs.statSync(source.path)
  if (!sameFile(before, after)) {
    throw new Error(`Agent Memory 在读取期间发生变化：${source.path}`)
  }

  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(contentBuffer)
  } catch {
    throw new Error(`Agent Memory 不是有效 UTF-8：${source.path}`)
  }

  return {
    source: {
      ...source,
      modifiedAt: before.mtime.toISOString(),
      sizeBytes: before.size,
    },
    content,
  }
}
