import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import { sharedOpenCodeServerManager } from './opencode-server-manager.js'
import { JsonlRpcProcess } from './jsonl-rpc-process.js'
import {
  getProviderEnabled,
  getProviderCapabilities,
  mergeProviderModels,
  PROVIDER_LABELS,
  redactDiagnosticText,
  type ProviderDiagnostic,
  type ProviderModel,
  type ProviderSnapshotEntry,
} from '../../core/src/provider-catalog.js'
import {
  loadLlmConfig,
  type LlmConfig,
  type LlmProvider,
} from '../../core/src/config.js'

const execFileAsync = promisify(execFile)
const PROBE_TIMEOUT_MS = 15_000

const FALLBACK_MODELS: Record<LlmProvider, ProviderModel[]> = {
  claude: [
    { id: 'sonnet', label: 'Claude Sonnet', description: 'Claude Code model alias', source: 'fallback' },
    { id: 'opus', label: 'Claude Opus', description: 'Claude Code model alias', source: 'fallback' },
    { id: 'haiku', label: 'Claude Haiku', description: 'Claude Code model alias', source: 'fallback' },
  ],
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Codex compatible model', source: 'fallback' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Codex compatible model', source: 'fallback' },
    { id: 'codex-auto-review', label: 'Codex Auto Review', description: 'Codex review model', source: 'fallback' },
  ],
  opencode: [],
  pi: [],
}

export async function probeProviders(
  provider?: LlmProvider,
  homeDir?: string,
): Promise<ProviderSnapshotEntry[]> {
  const config = loadLlmConfig(homeDir)
  const providers: LlmProvider[] = provider ? [provider] : ['claude', 'codex', 'opencode', 'pi']
  return Promise.all(providers.map((id) => probeProvider(id, config)))
}

export async function diagnoseProvider(
  provider: LlmProvider,
  homeDir?: string,
): Promise<ProviderDiagnostic> {
  const [entry] = await probeProviders(provider, homeDir)
  const checkedAt = new Date().toISOString()
  const executableAvailable =
    entry.status !== 'not-installed' && entry.status !== 'error'
  const catalogOk =
    entry.status === 'available' && !entry.error
  const lines = [
    `Provider: ${entry.label}`,
    `Checked at: ${checkedAt}`,
    `Executable: ${executableAvailable ? 'available' : 'unavailable'}`,
    `Version: ${entry.version ?? 'unknown'}`,
    `Authentication: ${catalogOk ? 'available' : 'unknown'}`,
    `Catalog: ${catalogOk ? `ok (${entry.models.length} models)` : `fallback/error (${entry.models.length} models)`}`,
    ...(entry.error ? [`Error: ${entry.error}`] : []),
  ]
  return {
    provider,
    checkedAt,
    executable: {
      available: executableAvailable,
      ...(entry.version ? { version: entry.version } : {}),
    },
    authenticated: catalogOk ? true : 'unknown',
    catalog: {
      ok: catalogOk,
      ...(catalogOk ? { modelCount: entry.models.length } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    },
    text: redactDiagnosticText(lines.join('\n')),
  }
}

async function probeProvider(
  provider: LlmProvider,
  config: LlmConfig,
): Promise<ProviderSnapshotEntry> {
  const enabled = getProviderEnabled(config, provider)
  if (!enabled) {
    return {
      id: provider,
      label: PROVIDER_LABELS[provider],
      status: 'disabled',
      enabled: false,
      isDefault: config.provider === provider,
      models: mergeModels(provider, [], config),
      capabilities: getProviderCapabilities(provider),
      fetchedAt: new Date().toISOString(),
    }
  }

  let version: string
  try {
    version = await probeVersion(provider)
  } catch (error) {
    return {
      id: provider,
      label: PROVIDER_LABELS[provider],
      status: isMissingExecutable(error) ? 'not-installed' : 'error',
      enabled: true,
      isDefault: config.provider === provider,
      models: mergeModels(provider, [], config),
      capabilities: getProviderCapabilities(provider),
      fetchedAt: new Date().toISOString(),
      error: errorMessage(error),
    }
  }

  try {
    const models = await discoverProviderModels(provider)
    return {
      id: provider,
      label: PROVIDER_LABELS[provider],
      status: 'available',
      enabled: true,
      isDefault: config.provider === provider,
      models: mergeModels(provider, models, config),
      capabilities: getProviderCapabilities(provider),
      fetchedAt: new Date().toISOString(),
      version,
    }
  } catch (error) {
    return {
      id: provider,
      label: PROVIDER_LABELS[provider],
      status: 'available',
      enabled: true,
      isDefault: config.provider === provider,
      models: mergeModels(provider, FALLBACK_MODELS[provider], config),
      capabilities: getProviderCapabilities(provider),
      fetchedAt: new Date().toISOString(),
      version,
      error: `模型目录探测失败，当前显示兼容目录：${errorMessage(error)}`,
    }
  }
}

function mergeModels(
  provider: LlmProvider,
  discovered: ProviderModel[],
  config: LlmConfig,
): ProviderModel[] {
  return mergeProviderModels(
    discovered,
    config.providers?.[provider]?.additionalModels ?? [],
  )
}

async function probeVersion(provider: LlmProvider): Promise<string> {
  const { stdout, stderr } = await execFileAsync(provider, ['--version'], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  })
  const version = `${stdout}${stderr}`.trim()
  if (!version) throw new Error(`${provider} --version 未返回版本`)
  return version.slice(0, 200)
}

function discoverProviderModels(provider: LlmProvider): Promise<ProviderModel[]> {
  switch (provider) {
    case 'claude': return discoverClaudeModels()
    case 'codex': return discoverCodexModels()
    case 'opencode': return discoverOpenCodeModels()
    case 'pi': return discoverPiModels()
  }
}

async function discoverClaudeModels(): Promise<ProviderModel[]> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const session = query({ prompt: '', options: { maxTurns: 1 } })
  try {
    const models = await withTimeout(session.supportedModels(), PROBE_TIMEOUT_MS)
    return models.map((model) => ({
      id: model.value,
      label: model.displayName,
      description: model.description,
      source: 'discovered' as const,
    }))
  } finally {
    session.close()
  }
}

async function discoverCodexModels(): Promise<ProviderModel[]> {
  const response = await runCodexModelList()
  return response.map((model) => ({
    id: model.model,
    label: model.displayName,
    description: model.description,
    source: 'discovered' as const,
  }))
}

async function discoverOpenCodeModels(): Promise<ProviderModel[]> {
  const lease = await sharedOpenCodeServerManager.acquire()
  try {
    const client = createOpencodeClient({ baseUrl: lease.url })
    const response = await withTimeout(
      client.provider.list({ directory: process.cwd() }),
      PROBE_TIMEOUT_MS,
    )
    if (response.error || !response.data) {
      throw new Error(JSON.stringify(response.error ?? 'OpenCode provider.list 无数据'))
    }
    return mapAccessibleOpenCodeModels(response.data)
  } finally {
    await lease.release()
  }
}

interface OpenCodeProviderCatalog {
  connected: string[]
  all: Array<{
    id: string
    name: string
    source: 'env' | 'config' | 'custom' | 'api'
    models: Record<string, {
      id: string
      name: string
      variants?: Record<string, unknown>
    }>
  }>
}

export function mapAccessibleOpenCodeModels(catalog: OpenCodeProviderCatalog): ProviderModel[] {
  const connectedProviderIds = new Set(catalog.connected)
  const accessibleProviders = catalog.all.filter((provider) =>
    connectedProviderIds.has(provider.id) || provider.source === 'api')
  if (accessibleProviders.length === 0) {
    throw new Error('OpenCode 没有已连接的 Provider，请先完成认证或配置 API Provider')
  }
  return accessibleProviders.flatMap((provider) =>
    Object.values(provider.models).map((model) => {
      const thinkingOptions = Object.keys(model.variants ?? {}).map((id) => ({ id, label: id }))
      return {
        id: `${provider.id}/${model.id}`,
        label: model.name,
        description: provider.name,
        source: 'discovered' as const,
        ...(thinkingOptions.length ? { thinkingOptions } : {}),
      }
    }))
}

async function discoverPiModels(): Promise<ProviderModel[]> {
  const response = await runPiRequest('get_available_models') as { models?: Array<Record<string, unknown>> }
  return (response.models ?? []).flatMap((model) => {
    if (typeof model.provider !== 'string' || typeof model.id !== 'string') return []
    const reasoning = model.reasoning === true
    return [{
      id: `${model.provider}/${model.id}`,
      label: typeof model.name === 'string' ? model.name : model.id,
      description: model.provider,
      source: 'discovered' as const,
      ...(reasoning ? {
        thinkingOptions: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
          .map((id) => ({ id, label: id })),
        defaultThinkingOptionId: 'medium',
      } : {}),
    }]
  })
}

async function runPiRequest(type: string): Promise<unknown> {
  const rpc = new JsonlRpcProcess({
    name: 'Pi RPC', command: 'pi', args: ['--mode', 'rpc'], cwd: process.cwd(),
    requestTimeoutMs: PROBE_TIMEOUT_MS,
  })
  try {
    return await rpc.request({ type })
  } finally {
    await rpc.close()
  }
}

interface CodexModelRow {
  model: string
  displayName: string
  description: string
}

function runCodexModelList(): Promise<CodexModelRow[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdoutBuffer = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error('Codex model/list 超时')), PROBE_TIMEOUT_MS)

    const finish = (error?: Error, models?: CodexModelRow[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (error) reject(error)
      else resolve(models ?? [])
    }
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_000)
    })
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (message.id === 1 && message.result) {
          send({ method: 'initialized', params: {} })
          send({ id: 2, method: 'model/list', params: {} })
        } else if (message.id === 2) {
          if (message.error) {
            finish(new Error(`Codex model/list 失败：${JSON.stringify(message.error)}`))
          } else {
            const result = message.result as { data?: CodexModelRow[] } | undefined
            finish(undefined, result?.data ?? [])
          }
        }
      }
    })
    child.on('error', finish)
    child.on('exit', (code) => {
      if (!settled) {
        finish(new Error(`Codex app-server 提前退出（${code ?? 'unknown'}）：${stderr.trim()}`))
      }
    })

    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'memory-manager', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    })
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Provider catalog 超时（${timeoutMs}ms）`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
