import type {
  CustomProviderModel,
  LlmConfig,
  LlmProvider,
} from './config.js'

export type ProviderStatus =
  | 'loading'
  | 'available'
  | 'not-installed'
  | 'error'
  | 'disabled'

export interface ProviderModel {
  id: string
  label: string
  description?: string
  source: 'discovered' | 'custom' | 'fallback'
  thinkingOptions?: ProviderThinkingOption[]
  defaultThinkingOptionId?: string
}

export interface ProviderThinkingOption {
  id: string
  label: string
}

export interface ProviderCapabilities {
  supportsStructuredOutput: boolean
  supportsFastMode: boolean
  sessionLifecycle: 'native' | 'app-only'
}

export interface ProviderSnapshotEntry {
  id: LlmProvider
  label: string
  status: ProviderStatus
  enabled: boolean
  isDefault: boolean
  models: ProviderModel[]
  capabilities: ProviderCapabilities
  fetchedAt?: string
  version?: string
  error?: string
}

export interface ProviderDiagnostic {
  provider: LlmProvider
  checkedAt: string
  executable: { available: boolean; version?: string }
  authenticated: boolean | 'unknown'
  catalog: { ok: boolean; modelCount?: number; error?: string }
  text: string
}

export const PROVIDER_LABELS: Record<LlmProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
}

const PROVIDER_CAPABILITIES: Record<LlmProvider, ProviderCapabilities> = {
  claude: { supportsStructuredOutput: true, supportsFastMode: true, sessionLifecycle: 'native' },
  codex: { supportsStructuredOutput: true, supportsFastMode: true, sessionLifecycle: 'native' },
  opencode: { supportsStructuredOutput: true, supportsFastMode: false, sessionLifecycle: 'native' },
  pi: { supportsStructuredOutput: false, supportsFastMode: false, sessionLifecycle: 'app-only' },
}

export function getProviderCapabilities(provider: LlmProvider): ProviderCapabilities {
  return { ...PROVIDER_CAPABILITIES[provider] }
}

export function getProviderEnabled(config: LlmConfig, provider: LlmProvider): boolean {
  return config.providers?.[provider]?.enabled ?? true
}

export function mergeProviderModels(
  discovered: ProviderModel[],
  custom: CustomProviderModel[],
): ProviderModel[] {
  const byId = new Map<string, ProviderModel>()
  for (const model of discovered) {
    if (!byId.has(model.id)) byId.set(model.id, { ...model })
  }
  for (const raw of custom) {
    const model = normalizeCustomModel(raw)
    const existing = byId.get(model.id)
    if (existing) {
      byId.set(model.id, {
        ...existing,
        ...(model.label ? { label: model.label } : {}),
        source: 'custom',
      })
    } else {
      byId.set(model.id, {
        id: model.id,
        label: model.label ?? model.id,
        source: 'custom',
      })
    }
  }
  return [...byId.values()]
}

export function normalizeCustomModel(model: CustomProviderModel): CustomProviderModel {
  const id = normalizeModelField(model.id, 'model id')
  const label = model.label === undefined
    ? undefined
    : normalizeModelField(model.label, 'model label')
  return { id, ...(label ? { label } : {}) }
}

function normalizeModelField(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} 必须是 1-200 字符的单行文本`)
  }
  return normalized
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(
      /\b([A-Za-z][A-Za-z0-9_]*(?:token|key|secret|password))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{4,})\b/g, '[REDACTED]')
    .slice(0, 20_000)
}
