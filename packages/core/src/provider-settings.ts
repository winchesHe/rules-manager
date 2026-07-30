import {
  loadLlmConfig,
  saveLlmConfig,
  type CustomProviderModel,
  type LlmConfig,
  type LlmProvider,
  type LlmProviderConfig,
} from './config.js'
import { normalizeCustomModel } from './provider-catalog.js'

export function setProviderEnabled(
  provider: LlmProvider,
  enabled: boolean,
  homeDir?: string,
): LlmConfig {
  const config = withProviderDefaults(loadLlmConfig(homeDir))
  if (!enabled && config.provider === provider) {
    throw new Error('当前默认 provider 不能禁用，请先选择另一个默认 provider')
  }
  return saveLlmConfig({
    ...config,
    providers: {
      ...config.providers,
      [provider]: {
        ...config.providers[provider],
        enabled,
      },
    },
  }, homeDir)
}

export function selectProviderModel(
  provider: LlmProvider,
  model?: string,
  homeDir?: string,
): LlmConfig {
  const config = withProviderDefaults(loadLlmConfig(homeDir))
  const normalizedModel = model?.trim()
  if (model !== undefined && !normalizedModel) {
    throw new Error('model 必须是非空字符串')
  }
  return saveLlmConfig({
    ...config,
    provider,
    ...(normalizedModel ? { model: normalizedModel } : { model: undefined }),
    providers: {
      ...config.providers,
      [provider]: {
        ...config.providers[provider],
        enabled: true,
      },
    },
  }, homeDir)
}

export function addCustomProviderModel(
  provider: LlmProvider,
  model: CustomProviderModel,
  homeDir?: string,
): LlmConfig {
  const config = withProviderDefaults(loadLlmConfig(homeDir))
  const normalized = normalizeCustomModel(model)
  const current = config.providers[provider].additionalModels ?? []
  return saveLlmConfig({
    ...config,
    providers: {
      ...config.providers,
      [provider]: {
        ...config.providers[provider],
        additionalModels: [
          ...current.filter((row) => row.id !== normalized.id),
          normalized,
        ],
      },
    },
  }, homeDir)
}

export function removeCustomProviderModel(
  provider: LlmProvider,
  modelId: string,
  homeDir?: string,
): LlmConfig {
  const config = withProviderDefaults(loadLlmConfig(homeDir))
  const normalizedId = normalizeCustomModel({ id: modelId }).id
  const remaining = (config.providers[provider].additionalModels ?? [])
    .filter((model) => model.id !== normalizedId)
  const clearsSelectedModel =
    config.provider === provider && config.model === normalizedId
  return saveLlmConfig({
    ...config,
    ...(clearsSelectedModel ? { model: undefined } : {}),
    providers: {
      ...config.providers,
      [provider]: {
        ...config.providers[provider],
        ...(remaining.length
          ? { additionalModels: remaining }
          : { additionalModels: undefined }),
      },
    },
  }, homeDir)
}

function withProviderDefaults(config: LlmConfig): LlmConfig & {
  providers: Record<LlmProvider, LlmProviderConfig>
} {
  return {
    ...config,
    providers: {
      claude: config.providers?.claude ?? { enabled: true },
      codex: config.providers?.codex ?? { enabled: true },
    },
  }
}
