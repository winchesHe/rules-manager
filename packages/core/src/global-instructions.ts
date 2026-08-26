import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TextDecoder } from 'node:util'

export const GLOBAL_INSTRUCTION_AGENTS = [
  'claude',
  'codex',
  'copilot',
  'opencode',
  'pi',
] as const

export type GlobalInstructionAgent = (typeof GLOBAL_INSTRUCTION_AGENTS)[number]

export interface GlobalInstructionSource {
  id: 'instructions'
  agent: GlobalInstructionAgent
  scope: 'global'
  kind: 'instructions'
  path: string
  format: 'markdown'
  status: 'present' | 'missing'
  effective: boolean
  discoveredFrom: 'default' | 'environment'
  note?: string
}

export interface GlobalInstructionError {
  agent: GlobalInstructionAgent
  path: string | null
  message: string
}

export interface GlobalInstructionListResult {
  agent: GlobalInstructionAgent | null
  count: number
  sources: GlobalInstructionSource[]
  errors: GlobalInstructionError[]
}

export interface GlobalInstructionListOptions {
  agent?: GlobalInstructionAgent
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

export interface GlobalInstructionShowResult {
  source: GlobalInstructionSource
  content: string
  revision: string
  modifiedAt: string
  sizeBytes: number
}

export interface GlobalInstructionReadResult {
  source: GlobalInstructionSource
  content: string
  revision: string | null
  modifiedAt: string | null
  sizeBytes: number
}

export interface GlobalInstructionSaveInput {
  content: string
  expectedRevision: string | null
}

const MAX_SHOW_BYTES = 1024 * 1024

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

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

function instructionSource(
  agent: GlobalInstructionAgent,
  filePath: string,
  discoveredFrom: 'default' | 'environment',
): GlobalInstructionSource {
  const present = isFile(filePath)
  return {
    id: 'instructions',
    agent,
    scope: 'global',
    kind: 'instructions',
    path: filePath,
    format: 'markdown',
    status: present ? 'present' : 'missing',
    effective: present,
    discoveredFrom,
  }
}

function sourceForAgent(
  agent: GlobalInstructionAgent,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): GlobalInstructionSource {
  switch (agent) {
    case 'claude': {
      const config = configRoot(homeDir, env, 'CLAUDE_CONFIG_DIR', '.claude')
      return instructionSource(agent, path.join(config.root, 'CLAUDE.md'), config.discoveredFrom)
    }
    case 'codex': {
      const config = configRoot(homeDir, env, 'CODEX_HOME', '.codex')
      return instructionSource(agent, path.join(config.root, 'AGENTS.md'), config.discoveredFrom)
    }
    case 'copilot':
      return instructionSource(
        agent,
        path.join(homeDir, '.copilot/copilot-instructions.md'),
        'default',
      )
    case 'opencode': {
      const config = configRoot(homeDir, env, 'XDG_CONFIG_HOME', '.config')
      return instructionSource(
        agent,
        path.join(config.root, 'opencode/AGENTS.md'),
        config.discoveredFrom,
      )
    }
    case 'pi': {
      const config = configRoot(homeDir, env, 'PI_CODING_AGENT_DIR', '.pi/agent')
      return instructionSource(agent, path.join(config.root, 'AGENTS.md'), config.discoveredFrom)
    }
  }
}

export function isAgentName(value: string): value is GlobalInstructionAgent {
  return GLOBAL_INSTRUCTION_AGENTS.includes(value as GlobalInstructionAgent)
}

export function listGlobalInstructionSources(
  options: GlobalInstructionListOptions = {},
): GlobalInstructionListResult {
  const homeDir = path.resolve(options.homeDir ?? os.homedir())
  const env = options.env ?? process.env
  const agents = options.agent ? [options.agent] : GLOBAL_INSTRUCTION_AGENTS
  const sources = agents.map((agent) => sourceForAgent(agent, homeDir, env))

  return {
    agent: options.agent ?? null,
    count: sources.length,
    sources,
    errors: [],
  }
}

export function showGlobalInstructionSource(
  agent: GlobalInstructionAgent,
  options: Omit<GlobalInstructionListOptions, 'agent'> = {},
): GlobalInstructionShowResult {
  const result = readGlobalInstructionSource(agent, options)
  if (result.source.status === 'missing' || result.revision === null || result.modifiedAt === null) {
    const source = result.source
    throw new Error(`规则来源不可读取（${source.status}）：${agent}/${source.id}`)
  }
  return {
    source: result.source,
    content: result.content,
    revision: result.revision,
    modifiedAt: result.modifiedAt,
    sizeBytes: result.sizeBytes,
  }
}

export function readGlobalInstructionSource(
  agent: GlobalInstructionAgent,
  options: Omit<GlobalInstructionListOptions, 'agent'> = {},
): GlobalInstructionReadResult {
  const source = sourceForAgent(
    agent,
    path.resolve(options.homeDir ?? os.homedir()),
    options.env ?? process.env,
  )
  if (source.status === 'missing') {
    return {
      source,
      content: '',
      revision: null,
      modifiedAt: null,
      sizeBytes: 0,
    }
  }
  const before = fs.statSync(source.path)
  if (!before.isFile()) throw new Error(`规则来源不是文件：${agent}/${source.id}`)
  if (before.size > MAX_SHOW_BYTES) {
    throw new Error(`规则文件超过 1 MiB：${source.path}`)
  }
  const contentBuffer = fs.readFileSync(source.path)
  const after = fs.statSync(source.path)
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`规则文件在读取期间发生变化：${source.path}`)
  }

  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(contentBuffer)
  } catch {
    throw new Error(`规则文件不是有效 UTF-8：${source.path}`)
  }
  return {
    source,
    content,
    revision: crypto.createHash('sha256').update(contentBuffer).digest('hex'),
    modifiedAt: before.mtime.toISOString(),
    sizeBytes: before.size,
  }
}

export function saveGlobalInstructionSource(
  agent: GlobalInstructionAgent,
  input: GlobalInstructionSaveInput,
  options: Omit<GlobalInstructionListOptions, 'agent'> = {},
): GlobalInstructionReadResult {
  if (typeof input.content !== 'string') throw new Error('规则内容必须是字符串')
  const contentBuffer = Buffer.from(input.content, 'utf8')
  if (contentBuffer.byteLength > MAX_SHOW_BYTES) {
    throw new Error('规则文件超过 1 MiB')
  }

  const current = readGlobalInstructionSource(agent, options)
  if (current.revision !== input.expectedRevision) {
    throw new Error(`规则文件自打开后已发生变化：${current.source.path}`)
  }

  const displayPath = current.source.path
  let targetPath = displayPath
  try {
    if (fs.lstatSync(displayPath).isSymbolicLink()) {
      targetPath = fs.realpathSync(displayPath)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const existingMode = current.source.status === 'present'
    ? fs.statSync(targetPath).mode & 0o777
    : 0o600
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', existingMode)
    fs.writeFileSync(descriptor, contentBuffer)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporaryPath, targetPath)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath)
  }

  return readGlobalInstructionSource(agent, options)
}
