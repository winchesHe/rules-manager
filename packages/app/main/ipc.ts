import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { BrowserWindow, ipcMain } from 'electron'
import Database from 'better-sqlite3'
import { listProjects, listProjectSessions } from '@memory-manager/core'
import { getDbPath, isDatabaseReady } from '@memory-manager/core/db'
import { resolveWorkspace } from '@memory-manager/core/workspace'
import {
  listRuleCandidates,
  updateRuleCandidateText,
  updateRuleCandidateStatus,
} from '@memory-manager/core/rule-candidates'
import { publishGlobalRulesToAgents } from '../../core/src/agent-instruction-publish.js'
import {
  isLlmEffort,
  loadLlmConfig,
  saveLlmConfig,
  type LlmConfig,
  type LlmEffort,
  type LlmProvider,
} from '../../core/src/config.js'
import { runRulesOutput } from '../../core/src/commands/rules-output.js'
import type { SessionPreview } from '../../core/src/evidence.js'
import {
  isAgentName as isGlobalInstructionAgent,
  listGlobalInstructionSources,
  readGlobalInstructionSource,
  saveGlobalInstructionSource,
} from '../../core/src/global-instructions.js'
import { ScanController, type ScanControllerEvent } from './scan-controller.js'
import { listCompletedScans, loadLatestCompletedScan } from './scan-history.js'
import {
  GenerationController,
  type GenerationControllerEvent,
  type GenerationRequest,
} from './generation-controller.js'
import { listGenerationHistory } from './generation-history.js'
import {
  ProviderController,
  type ProviderControllerEvent,
} from './provider-controller.js'
import {
  addCustomProviderModel,
  removeCustomProviderModel,
  selectProviderModel,
  setProviderEnabled,
} from '../../core/src/provider-settings.js'
import type { AgentName } from '../../core/src/types.js'
import { ChatStore } from './chat-store.js'

const chatStore = new ChatStore(resolveWorkspace().chatsDir)
const scanController = new ScanController(
  (request) =>
    new Worker(join(import.meta.dirname, 'scan-worker.js'), {
      workerData: request,
    }),
  broadcastScanEvent,
)
const generationController = new GenerationController(
  (request) =>
    new Worker(join(import.meta.dirname, 'generation-worker.js'), {
      workerData: request,
    }),
  broadcastGenerationEvent,
  chatStore,
)
const providerController = new ProviderController(
  (request) =>
    new Worker(join(import.meta.dirname, 'provider-worker.js'), {
      workerData: request,
    }),
  broadcastProviderEvent,
)

export function registerIpcHandlers(): void {
  markInterruptedBackgroundRuns()
  ipcMain.handle('projects.list', () => listProjects())
  ipcMain.handle('projects.sessions', (_event, slug: unknown) => {
    if (typeof slug !== 'string' || !slug.trim()) {
      throw new Error('project slug is required')
    }
    if (!isDatabaseReady()) return []
    return listProjectSessions({ slug })
  })
  ipcMain.handle('sessions.preview', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new Error('session id is required')
    }
    if (!isDatabaseReady()) throw new Error('database is not ready')
    return runSessionPreviewWorker(sessionId)
  })
  ipcMain.handle('chat.list', () => chatStore.listThreads())
  ipcMain.handle('chat.read', (_event, threadId: unknown) => {
    if (typeof threadId !== 'string' || !threadId.trim()) {
      throw new Error('chat thread id is required')
    }
    return chatStore.readThread(threadId)
  })

  ipcMain.handle('scan.run', (_event, value?: unknown) => {
    const request = validateScanRequest(value)
    return scanController.start(request.agents, request.sinceDays)
  })
  ipcMain.handle('scan.status', () => {
    const liveStatus = scanController.status()
    if (liveStatus.running || liveStatus.summary || !isDatabaseReady()) return liveStatus
    const storedStatus = loadLatestCompletedScan(getDbPath())
    return storedStatus ? { ...liveStatus, ...storedStatus } : liveStatus
  })
  ipcMain.handle('scan.cancel', (_event, value?: unknown) => {
    const runId = validateRunId(value)
    return scanController.cancel(runId)
  })
  ipcMain.handle('scan.history', () => {
    if (!isDatabaseReady()) return []
    return listCompletedScans(getDbPath())
  })

  ipcMain.handle('settings.load', () => loadLlmConfig())
  ipcMain.handle('settings.save', (_event, config: unknown) =>
    saveLlmConfig(config as LlmConfig),
  )
  ipcMain.handle('settings.providers.snapshot', () => {
    const snapshot = providerController.snapshot()
    if (snapshot.entries.length === 0 && !snapshot.refreshing) {
      providerController.refresh()
    }
    return providerController.snapshot()
  })
  ipcMain.handle('settings.providers.refresh', (_event, provider?: LlmProvider) =>
    providerController.refresh(provider),
  )
  ipcMain.handle('settings.providers.diagnostic', (_event, provider: LlmProvider) =>
    providerController.diagnose(provider),
  )
  ipcMain.handle(
    'settings.providers.setEnabled',
    (_event, provider: LlmProvider, enabled: boolean) => {
      const config = setProviderEnabled(provider, enabled)
      providerController.refresh(provider)
      return config
    },
  )
  ipcMain.handle(
    'settings.providers.selectModel',
    (_event, provider: LlmProvider, model?: string) => {
      const config = selectProviderModel(provider, model)
      providerController.refresh()
      return config
    },
  )
  ipcMain.handle(
    'settings.providers.addModel',
    (_event, provider: LlmProvider, model: { id: string; label?: string }) => {
      const config = addCustomProviderModel(provider, model)
      providerController.refresh(provider)
      return config
    },
  )
  ipcMain.handle(
    'settings.providers.removeModel',
    (_event, provider: LlmProvider, modelId: string) => {
      const config = removeCustomProviderModel(provider, modelId)
      providerController.refresh(provider)
      return config
    },
  )

  ipcMain.handle('rules.generate', (_event, request?: unknown) => {
    const generation = validateGenerateRequest(request)
    return generationController.start(generation)
  })
  ipcMain.handle('rules.generate.status', () => generationController.status())
  ipcMain.handle('rules.generate.history', () => {
    if (!isDatabaseReady()) return []
    return listGenerationHistory(getDbPath())
  })
  ipcMain.handle('rules.generate.cancel', (_event, value?: unknown) => {
    const runId = validateRunId(value)
    return generationController.cancel(runId)
  })
  ipcMain.handle('rules.instructions.list', () => listGlobalInstructionSources())
  ipcMain.handle('rules.instructions.read', (_event, agent: unknown) => {
    if (typeof agent !== 'string' || !isGlobalInstructionAgent(agent)) {
      throw new Error('unsupported global instruction agent')
    }
    return readGlobalInstructionSource(agent)
  })
  ipcMain.handle('rules.instructions.save', (_event, agent: unknown, value: unknown) => {
    if (typeof agent !== 'string' || !isGlobalInstructionAgent(agent)) {
      throw new Error('unsupported global instruction agent')
    }
    if (!value || typeof value !== 'object') {
      throw new Error('invalid global instruction save request')
    }
    const { content, expectedRevision } = value as {
      content?: unknown
      expectedRevision?: unknown
    }
    if (
      typeof content !== 'string'
      || (expectedRevision !== null && typeof expectedRevision !== 'string')
    ) {
      throw new Error('invalid global instruction save request')
    }
    return saveGlobalInstructionSource(agent, {
      content,
      expectedRevision: expectedRevision as string | null,
    })
  })

  ipcMain.handle('rules.output', () => {
    const paths: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      originalLog(...args)
      const match = /^(?:已写入|未变化)：(.+)$/.exec(args.map(String).join(' '))
      if (match) paths.push(match[1])
    }
    try {
      runRulesOutput({ all: true })
      return paths
    } finally {
      console.log = originalLog
    }
  })

  ipcMain.handle('rules.candidates', (_event, status?: string) => {
    if (!isDatabaseReady()) return []
    return listRuleCandidates(undefined, status ?? 'draft')
  })

  ipcMain.handle('rules.updateStatus', (_event, id: string, status: string) => {
    if (typeof id !== 'string' || !id) throw new Error('candidate id is required')
    if (status !== 'accepted' && status !== 'rejected') {
      throw new Error(`unsupported candidate status: ${status}`)
    }
    return updateRuleCandidateStatus(id, status)
  })
  ipcMain.handle('rules.updateText', (_event, id: unknown, ruleText: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('candidate id is required')
    if (typeof ruleText !== 'string') throw new Error('candidate rule text is required')
    return updateRuleCandidateText(id, ruleText)
  })
  ipcMain.handle('rules.publishAgents', (_event, value: unknown) => {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error('at least one publish target is required')
    }
    const targets = value.map((item) => {
      if (!item || typeof item !== 'object') {
        throw new Error('invalid publish target')
      }
      const { agent, expectedRevision } = item as {
        agent?: unknown
        expectedRevision?: unknown
      }
      if (typeof agent !== 'string' || !isGlobalInstructionAgent(agent)) {
        throw new Error('unsupported publish target')
      }
      if (expectedRevision !== null && typeof expectedRevision !== 'string') {
        throw new Error('invalid publish target revision')
      }
      return {
        agent,
        expectedRevision: expectedRevision as string | null,
      }
    })
    return publishGlobalRulesToAgents(targets)
  })
}

function markInterruptedBackgroundRuns(): void {
  chatStore.markInterruptedThreads()
  if (!isDatabaseReady()) return
  const db = new Database(getDbPath())
  try {
    db.prepare(`
      UPDATE run_metadata
      SET status = 'interrupted', ended_at = COALESCE(ended_at, ?)
      WHERE run_type IN ('scan', 'generate-rules')
        AND status IN ('running', 'cancelling')
    `).run(new Date().toISOString())
  } finally {
    db.close()
  }
}

function runSessionPreviewWorker(sessionId: string): Promise<SessionPreview> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(import.meta.dirname, 'session-preview-worker.js'), {
      workerData: { sessionId },
    })
    let settled = false

    worker.once('message', (message: unknown) => {
      settled = true
      if (
        message
        && typeof message === 'object'
        && 'type' in message
        && message.type === 'done'
        && 'preview' in message
      ) {
        resolve(message.preview as SessionPreview)
        return
      }
      const errorMessage = message
        && typeof message === 'object'
        && 'message' in message
        && typeof message.message === 'string'
        ? message.message
        : 'Session preview worker returned an invalid response'
      reject(new Error(errorMessage))
    })
    worker.once('error', (error) => {
      settled = true
      reject(error)
    })
    worker.once('exit', (code) => {
      if (!settled) {
        reject(new Error(`Session preview worker exited before completion (${code})`))
      }
    })
  })
}

const supportedAgents: AgentName[] = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'opencode',
  'pi',
]

function validateScanRequest(value: unknown): {
  agents: AgentName[]
  sinceDays?: number
} {
  if (value === undefined) return { agents: [] }
  const request = Array.isArray(value) ? { agents: value } : value
  if (!request || typeof request !== 'object') {
    throw new Error('invalid scan request')
  }
  const { agents: rawAgents, sinceDays } = request as {
    agents?: unknown
    sinceDays?: unknown
  }
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    throw new Error('scan agents must be a non-empty array')
  }
  const agents = [...new Set(rawAgents)]
  if (
    agents.some(
      (agent) => typeof agent !== 'string' || !supportedAgents.includes(agent as AgentName),
    )
  ) {
    throw new Error('scan agents contain an unsupported agent')
  }
  if (
    sinceDays !== undefined &&
    (typeof sinceDays !== 'number' || !Number.isInteger(sinceDays) || sinceDays <= 0)
  ) {
    throw new Error('scan sinceDays must be a positive integer')
  }
  return { agents: agents as AgentName[], sinceDays }
}

function validateGenerateRequest(value: unknown): GenerationRequest {
  const config = loadLlmConfig()
  if (value === undefined) {
    return {
      mode: 'recent',
      projects: [],
      provider: config.provider,
      effort: config.effort,
      fastMode: config.fastMode ?? false,
    }
  }
  if (!value || typeof value !== 'object') throw new Error('invalid generation request')
  const request = value as {
    mode?: unknown
    projects?: unknown
    provider?: unknown
    effort?: unknown
    fastMode?: unknown
  }
  const provider = request.provider ?? config.provider
  const effort = request.effort ?? config.effort
  const fastMode = request.fastMode ?? config.fastMode ?? false
  if (provider !== 'claude' && provider !== 'codex') {
    throw new Error('generation provider must be claude or codex')
  }
  if (config.providers?.[provider]?.enabled === false) {
    throw new Error('generation provider is disabled')
  }
  if (!isLlmEffort(effort)) {
    throw new Error('generation effort is unsupported')
  }
  if (typeof fastMode !== 'boolean') {
    throw new Error('generation fastMode must be boolean')
  }
  const options: {
    provider: LlmProvider
    effort: LlmEffort
    fastMode: boolean
  } = { provider, effort, fastMode }
  if (
    request.mode === 'recent'
    || request.mode === 'changed7d'
    || request.mode === 'full'
  ) {
    return { mode: request.mode, projects: [], ...options }
  }
  if (request.mode !== 'projects' || !Array.isArray(request.projects)) {
    throw new Error('unsupported generation mode')
  }
  const projects = [...new Set(request.projects)]
  if (
    projects.length === 0 ||
    projects.some((project) => typeof project !== 'string' || !project.trim())
  ) {
    throw new Error('at least one project is required')
  }
  return { mode: 'projects', projects: projects as string[], ...options }
}

function validateRunId(value: unknown): string {
  if (
    !value
    || typeof value !== 'object'
    || !('runId' in value)
    || typeof value.runId !== 'string'
    || !value.runId.trim()
  ) {
    throw new Error('runId is required')
  }
  return value.runId
}

function broadcastGenerationEvent(event: GenerationControllerEvent): void {
  const channel =
    event.type === 'progress'
      ? 'generate.progress'
      : event.type === 'event'
        ? 'generate.event'
      : event.type === 'done'
        ? 'generate.done'
        : event.type === 'cancelled'
          ? 'generate.cancelled'
        : 'generate.failed'
  const payload =
    event.type === 'progress'
      ? { ...event.progress, runId: event.runId, seq: event.seq, at: event.at }
      : event.type === 'event'
        ? event
      : event.type === 'done'
        ? { ...event.result, runId: event.runId, seq: event.seq, at: event.at }
        : event.type === 'cancelled'
          ? event
          : { message: event.message, runId: event.runId, seq: event.seq, at: event.at }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function broadcastProviderEvent(event: ProviderControllerEvent): void {
  const channel =
    event.type === 'updated'
      ? 'settings.providers.updated'
      : event.type === 'diagnostic'
        ? 'settings.providers.diagnostic.done'
        : 'settings.providers.failed'
  const payload =
    event.type === 'updated'
      ? event.snapshot
      : event.type === 'diagnostic'
        ? event.diagnostic
        : { message: event.message }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function broadcastScanEvent(event: ScanControllerEvent): void {
  const channel =
    event.type === 'progress'
      ? 'scan.progress'
      : event.type === 'done'
        ? 'scan.done'
        : event.type === 'cancelled'
          ? 'scan.cancelled'
        : 'scan.failed'
  const payload =
    event.type === 'progress'
      ? { ...event.progress, runId: event.runId, seq: event.seq, at: event.at }
      : event.type === 'done'
        ? { ...event.summary, runId: event.runId, seq: event.seq, at: event.at }
        : event.type === 'cancelled'
          ? event
          : { message: event.message, runId: event.runId, seq: event.seq, at: event.at }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload)
  }
}
