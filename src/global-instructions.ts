import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import type { AgentName } from './types.js'

export interface GlobalInstructionSource {
  id: 'instructions' | 'user-rules'
  agent: AgentName
  scope: 'global'
  kind: 'instructions' | 'ui-capability'
  path: string | null
  format: 'markdown' | 'ui'
  status: 'present' | 'missing' | 'unsupported'
  effective: boolean
  discoveredFrom: 'default' | 'environment' | 'capability'
  note?: string
}

export interface GlobalInstructionError {
  agent: AgentName
  path: string | null
  message: string
}

export interface GlobalInstructionListResult {
  agent: AgentName | null
  count: number
  sources: GlobalInstructionSource[]
  errors: GlobalInstructionError[]
}

export interface GlobalInstructionListOptions {
  agent?: AgentName
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

export interface GlobalInstructionShowResult {
  source: GlobalInstructionSource
  content: string
}

const AGENT_NAMES: AgentName[] = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'opencode',
  'pi',
]
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
  agent: AgentName,
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
  agent: AgentName,
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
    case 'cursor':
      return {
        id: 'user-rules',
        agent,
        scope: 'global',
        kind: 'ui-capability',
        path: null,
        format: 'ui',
        status: 'unsupported',
        effective: false,
        discoveredFrom: 'capability',
        note: 'Cursor User Rules 由 Customize → Rules 管理，没有稳定的公开文件 API',
      }
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

export function isAgentName(value: string): value is AgentName {
  return AGENT_NAMES.includes(value as AgentName)
}

export function listGlobalInstructionSources(
  options: GlobalInstructionListOptions = {},
): GlobalInstructionListResult {
  const homeDir = path.resolve(options.homeDir ?? os.homedir())
  const env = options.env ?? process.env
  const agents = options.agent ? [options.agent] : AGENT_NAMES
  const sources = agents.map((agent) => sourceForAgent(agent, homeDir, env))

  return {
    agent: options.agent ?? null,
    count: sources.length,
    sources,
    errors: [],
  }
}

export function showGlobalInstructionSource(
  agent: AgentName,
  options: Omit<GlobalInstructionListOptions, 'agent'> = {},
): GlobalInstructionShowResult {
  const result = listGlobalInstructionSources({ ...options, agent })
  const source = result.sources[0]
  if (source.status === 'missing' || source.status === 'unsupported') {
    throw new Error(`规则来源不可读取（${source.status}）：${agent}/${source.id}`)
  }
  if (!source.path) throw new Error(`规则来源没有文件路径：${agent}/${source.id}`)

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
  return { source, content }
}
