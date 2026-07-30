import fs from 'node:fs'
import path from 'node:path'
import { resolveWorkspace } from './workspace.js'

export type LlmProvider = 'claude' | 'codex'
export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface CustomProviderModel {
  id: string
  label?: string
}

export interface LlmProviderConfig {
  enabled: boolean
  additionalModels?: CustomProviderModel[]
}

export interface LlmConfig {
  provider: LlmProvider
  model?: string
  effort: LlmEffort
  fastMode?: boolean
  providers?: Partial<Record<LlmProvider, LlmProviderConfig>>
}

const DEFAULT_CONFIG: LlmConfig = {
  provider: 'claude',
  effort: 'medium',
}

export function loadLlmConfig(homeDir?: string): LlmConfig {
  const configPath = path.join(resolveWorkspace(homeDir).workspaceDir, 'config.json')
  if (!fs.existsSync(configPath)) return { ...DEFAULT_CONFIG }

  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`config.json 解析失败：${message}`)
  }
  return normalizeLlmConfig(value, false)
}

export function saveLlmConfig(config: LlmConfig, homeDir?: string): LlmConfig {
  const normalized = normalizeLlmConfig(config, true)
  const { workspaceDir } = resolveWorkspace(homeDir)
  const configPath = path.join(workspaceDir, 'config.json')
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`

  fs.mkdirSync(workspaceDir, { recursive: true })
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    fs.renameSync(temporaryPath, configPath)
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true })
    throw error
  }
  return normalized
}

function normalizeLlmConfig(value: unknown, includeProviderDefaults: boolean): LlmConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config.json 必须是 JSON object')
  }

  const config = value as Record<string, unknown>
  const provider = config.provider ?? DEFAULT_CONFIG.provider
  const effort = config.effort ?? DEFAULT_CONFIG.effort
  const fastMode = config.fastMode
  const model = config.model
  const providers = normalizeProviders(config.providers, includeProviderDefaults)
  if (provider !== 'claude' && provider !== 'codex') {
    throw new Error('config.json provider 只支持 claude 或 codex')
  }
  if (!isLlmEffort(effort)) {
    throw new Error('config.json effort 只支持 low、medium、high、xhigh 或 max')
  }
  if (fastMode !== undefined && typeof fastMode !== 'boolean') {
    throw new Error('config.json fastMode 必须是 boolean')
  }
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    throw new Error('config.json model 必须是非空字符串')
  }
  if (providers && providers[provider]?.enabled === false) {
    throw new Error('默认 provider 必须启用')
  }
  if (
    providers &&
    !Object.values(providers).some((providerConfig) => providerConfig?.enabled)
  ) {
    throw new Error('至少需要启用一个 provider')
  }

  return {
    provider,
    effort,
    ...(typeof model === 'string' ? { model: model.trim() } : {}),
    ...(typeof fastMode === 'boolean' ? { fastMode } : {}),
    ...(providers ? { providers } : {}),
  }
}

export function isLlmEffort(value: unknown): value is LlmEffort {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
}

function normalizeProviders(
  value: unknown,
  includeDefaults: boolean,
): LlmConfig['providers'] {
  if (value === undefined && !includeDefaults) return undefined
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('config.json providers 必须是 JSON object')
  }

  const input = (value ?? {}) as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (key !== 'claude' && key !== 'codex') {
      throw new Error(`不支持的 provider 配置：${key}`)
    }
  }

  return {
    claude: normalizeProviderConfig(input.claude),
    codex: normalizeProviderConfig(input.codex),
  }
}

function normalizeProviderConfig(value: unknown): LlmProviderConfig {
  if (value === undefined) return { enabled: true }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provider 配置必须是 JSON object')
  }
  const config = value as Record<string, unknown>
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new Error('provider enabled 必须是 boolean')
  }
  if (config.additionalModels !== undefined && !Array.isArray(config.additionalModels)) {
    throw new Error('provider additionalModels 必须是 array')
  }
  const additionalModels = config.additionalModels?.map((model) => {
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
      throw new Error('custom model 必须是 JSON object')
    }
    const row = model as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id.trim() === '') {
      throw new Error('custom model id 必须是非空字符串')
    }
    if (row.label !== undefined && (typeof row.label !== 'string' || row.label.trim() === '')) {
      throw new Error('custom model label 必须是非空字符串')
    }
    return {
      id: row.id.trim(),
      ...(typeof row.label === 'string' ? { label: row.label.trim() } : {}),
    }
  })
  return {
    enabled: config.enabled ?? true,
    ...(additionalModels?.length ? { additionalModels } : {}),
  }
}
