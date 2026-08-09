import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { BrowserWindow, ipcMain, shell } from 'electron'
import Database from 'better-sqlite3'
import { listProjects, type ProjectSessionMetadata } from '@memory-manager/core'
import {
  querySessionContext,
  resolveSessionContextItems,
} from '../../core/src/session-context.js'
import { getDbPath, isDatabaseReady } from '@memory-manager/core/db'
import { resolveWorkspace } from '@memory-manager/core/workspace'
import {
  listRuleCandidates,
  updateRuleCandidatesStatus,
  updateRuleCandidateText,
  updateRuleCandidateStatus,
} from '@memory-manager/core/rule-candidates'
import { publishGlobalRulesToAgents } from '../../core/src/agent-instruction-publish.js'
import {
  isLlmEffort,
  isLlmProvider,
  loadLlmConfig,
  saveLlmConfig,
  type LlmConfig,
  type LlmEffort,
  type LlmProvider,
} from '../../core/src/config.js'
import {
  readProjectRulesOutput,
  runRulesOutput,
} from '../../core/src/commands/rules-output.js'
import type {
  SessionEvidenceContext,
  SessionPreview,
} from '../../core/src/evidence.js'
import {
  isAgentName as isGlobalInstructionAgent,
  listGlobalInstructionSources,
  readGlobalInstructionSource,
  saveGlobalInstructionSource,
} from '../../core/src/global-instructions.js'
import {
  isAutoMemoryAgent,
  listAutoMemorySources,
  readAutoMemorySource,
} from '../../core/src/auto-memories.js'
import {
  listClaudeProjectMemoryPublishTargets,
  publishProjectRulesToClaudeMemory,
  type ClaudeProjectMemoryPublicationStatus,
} from '../../core/src/project-memory-publish.js'
import {
  publishProjectRulesToCodexMemory,
  type CodexProjectMemoryPublicationStatus,
  type CodexProjectMemoryPublishTarget,
} from '../../core/src/codex-project-memory-publish.js'
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
import { getProviderCapabilities } from '../../core/src/provider-catalog.js'
import type { AgentName } from '../../core/src/types.js'
import { ChatStore } from './chat-store.js'
import { ChatRuntimeManager } from './chat-runtime.js'
import { ClaudeChatAdapter } from './claude-chat-adapter.js'
import { CodexChatAdapter } from './codex-chat-adapter.js'
import { OpenCodeChatAdapter } from './opencode-chat-adapter.js'
import { sharedOpenCodeServerManager } from './opencode-server-manager.js'
import { PiChatAdapter } from './pi-chat-adapter.js'
import { NativeChatController } from './native-chat-controller.js'
import { listChatSkills } from './chat-skills.js'
import { resolveProjectLocation, resolveSessionLocation } from './source-location.js'
import { validateSessionReferences } from './session-context-validation.js'
import { validatePastedTextAttachments } from './pasted-text-validation.js'
import { recordChatCompletion } from './app-badge.js'
import { toggleWindowMaximize } from './window-maximize.js'

const workspace = resolveWorkspace()
const chatStore = new ChatStore(workspace.chatsDir)
const chatRuntime = new ChatRuntimeManager((provider) => {
  if (provider === 'claude') return new ClaudeChatAdapter()
  if (provider === 'codex') return new CodexChatAdapter()
  if (provider === 'opencode') return new OpenCodeChatAdapter()
  return new PiChatAdapter()
})
const nativeChatController = new NativeChatController({
  store: chatStore,
  runtime: chatRuntime,
  workingDirectory: workspace.workspaceDir,
  enableSessionEvidence: true,
  onEvent: broadcastNativeChatEvent,
  onThreadChanged: broadcastNativeChatChanged,
  onTurnCompleted: recordChatCompletion,
})
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

export async function shutdownNativeChatRuntimes(): Promise<void> {
  await chatRuntime.close()
  await sharedOpenCodeServerManager.shutdown()
}

export function registerIpcHandlers(): void {
  markInterruptedBackgroundRuns()
  ipcMain.handle('window.toggleMaximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) throw new Error('window was not found')
    return toggleWindowMaximize(window)
  })
  ipcMain.handle('projects.list', () => listProjects())
  ipcMain.handle('projects.sessions', (_event, slug: unknown) => {
    if (typeof slug !== 'string' || !slug.trim()) {
      throw new Error('project slug is required')
    }
    if (!isDatabaseReady()) return []
    return runProjectSessionsWorker(slug)
  })
  ipcMain.handle('projects.reveal', async (_event, slug: unknown) => {
    if (typeof slug !== 'string') throw new Error('project slug is required')
    const result = await shell.openPath(resolveProjectLocation(slug))
    if (result) throw new Error(result)
  })
  ipcMain.handle('sessions.reveal', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('session id is required')
    shell.showItemInFolder(resolveSessionLocation(sessionId))
  })
  ipcMain.handle('sessions.preview', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new Error('session id is required')
    }
    if (!isDatabaseReady()) throw new Error('database is not ready')
    return runSessionPreviewWorker(sessionId)
  })
  ipcMain.handle('sessions.evidenceContext', (_event, value: unknown) => {
    if (!value || typeof value !== 'object') {
      throw new Error('evidence locator is required')
    }
    const locator = value as Record<string, unknown>
    if (typeof locator.sessionId !== 'string' || !locator.sessionId.trim()) {
      throw new Error('session id is required')
    }
    if (!Number.isInteger(locator.messageIndex) || Number(locator.messageIndex) < 0) {
      throw new Error('message index must be a non-negative integer')
    }
    if (!isDatabaseReady()) throw new Error('database is not ready')
    return runSessionEvidenceContextWorker(locator.sessionId, Number(locator.messageIndex))
  })
  ipcMain.handle('chat.list', () => chatStore.listThreads())
  ipcMain.handle('chat.read', (_event, threadId: unknown) => {
    if (typeof threadId !== 'string' || !threadId.trim()) {
      throw new Error('chat thread id is required')
    }
    return chatStore.readThread(threadId)
  })
  ipcMain.handle('chat.send', (_event, value: unknown) => {
    return nativeChatController.send(validateNativeChatSendRequest(value))
  })
  ipcMain.handle('chat.interrupt', (_event, threadId: unknown) => {
    if (typeof threadId !== 'string' || !threadId.trim()) {
      throw new Error('chat thread id is required')
    }
    return nativeChatController.interrupt(threadId)
  })
  ipcMain.handle('chat.interaction.respond', (_event, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid interaction response')
    }
    const response = value as Record<string, unknown>
    if (typeof response.chatId !== 'string' || !response.chatId.trim()) {
      throw new Error('chat id is required')
    }
    if (typeof response.requestId !== 'string' || !response.requestId.trim()) {
      throw new Error('interaction request id is required')
    }
    if (!response.answers || typeof response.answers !== 'object' || Array.isArray(response.answers)) {
      throw new Error('interaction answers are required')
    }
    const answers = Object.fromEntries(Object.entries(response.answers).map(([key, answer]) => {
      if (!Array.isArray(answer) || !answer.every((item) => typeof item === 'string')) {
        throw new Error('interaction answer must be a string array')
      }
      return [key, answer as string[]]
    }))
    return chatRuntime.respondToInteraction(response.chatId, {
      requestId: response.requestId,
      answers,
      ...(response.cancelled === true ? { cancelled: true } : {}),
    })
  })
  ipcMain.handle('chat.skills', (_event, provider: unknown) => {
    if (!isLlmProvider(provider)) {
      throw new Error('invalid chat provider')
    }
    return listChatSkills(provider)
  })
  ipcMain.handle('chat.tool.read', (_event, value: unknown) => {
    return nativeChatController.readToolItem(validateNativeChatToolReadRequest(value))
  })
  ipcMain.handle('chat.context.query', (_event, value: unknown) => {
    return querySessionContext(validateSessionContextQuery(value))
  })
  ipcMain.handle('chat.context.update', (_event, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid session context update')
    }
    const request = value as Record<string, unknown>
    if (typeof request.chatId !== 'string' || !request.chatId.trim()) {
      throw new Error('chat id is required')
    }
    return nativeChatController.updateSessionContext(
      request.chatId,
      validateSessionReferences(request.selected),
    )
  })
  ipcMain.handle('chat.context.resolve', (_event, value: unknown) => {
    return resolveSessionContextItems(validateSessionReferences(value))
  })
  ipcMain.handle('chat.rename', (_event, value: unknown) => {
    const request = validateChatLifecycleRequest(value, true)
    nativeChatController.rename(request.chatId, request.title)
  })
  ipcMain.handle('chat.pin', (_event, value: unknown) => {
    nativeChatController.pin(validateChatLifecycleRequest(value).chatId)
  })
  ipcMain.handle('chat.unpin', (_event, value: unknown) => {
    nativeChatController.unpin(validateChatLifecycleRequest(value).chatId)
  })
  ipcMain.handle('chat.archive', (_event, value: unknown) => {
    return nativeChatController.archive(validateChatLifecycleRequest(value).chatId)
  })
  ipcMain.handle('chat.unarchive', (_event, value: unknown) => {
    return nativeChatController.unarchive(validateChatLifecycleRequest(value).chatId)
  })
  ipcMain.handle('chat.delete', (_event, value: unknown) => {
    return nativeChatController.deleteArchived(validateChatLifecycleRequest(value).chatId)
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
  ipcMain.handle('rules.chat.start', (_event, request?: unknown) => {
    return nativeChatController.startRulesGeneration(validateGenerateRequest(request))
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
  ipcMain.handle('rules.memories.list', () => listAutoMemorySources())
  ipcMain.handle('rules.memories.read', (_event, agent: unknown, memoryId: unknown) => {
    if (typeof agent !== 'string' || !isAutoMemoryAgent(agent)) {
      throw new Error('unsupported auto memory agent')
    }
    if (typeof memoryId !== 'string' || !memoryId.trim()) {
      throw new Error('memory id is required')
    }
    return readAutoMemorySource(agent, memoryId)
  })
  ipcMain.handle('rules.memories.reveal', (_event, agent: unknown, memoryId: unknown) => {
    if (typeof agent !== 'string' || !isAutoMemoryAgent(agent)) {
      throw new Error('unsupported auto memory agent')
    }
    if (typeof memoryId !== 'string' || !memoryId.trim()) {
      throw new Error('memory id is required')
    }
    const source = listAutoMemorySources({ agent }).sources.find(
      (candidate) => candidate.id === memoryId,
    )
    if (!source) throw new Error(`未知的 Agent Memory：${agent}/${memoryId}`)
    if (source.status !== 'present') {
      throw new Error(`Agent Memory 尚未生成：${agent}/${source.id}`)
    }
    shell.showItemInFolder(source.path)
  })
  ipcMain.handle('rules.memories.publishTargets', () =>
    listClaudeProjectMemoryPublishTargets())
  ipcMain.handle('rules.memories.publishProjectRules', (_event, value: unknown) => {
    if (!value || typeof value !== 'object') {
      throw new Error('invalid project memory publish request')
    }
    const {
      memoryId,
      ruleIds,
      expectedRevision,
      expectedTopicRevision,
    } = value as {
      memoryId?: unknown
      ruleIds?: unknown
      expectedRevision?: unknown
      expectedTopicRevision?: unknown
    }
    if (typeof memoryId !== 'string' || !memoryId.trim()) {
      throw new Error('project memory target is required')
    }
    if (
      !Array.isArray(ruleIds)
      || ruleIds.length === 0
      || ruleIds.some((id) => typeof id !== 'string' || !id.trim())
    ) {
      throw new Error('project rule ids are required')
    }
    if (typeof expectedRevision !== 'string') {
      throw new Error('project memory revision is required')
    }
    if (expectedTopicRevision !== null && typeof expectedTopicRevision !== 'string') {
      throw new Error('invalid project memory topic revision')
    }
    return publishProjectRulesToClaudeMemory({
      memoryId,
      ruleIds: ruleIds as string[],
      expectedRevision,
      expectedTopicRevision: expectedTopicRevision as string | null,
    })
  })
  ipcMain.handle('rules.memories.codexProjectTargets', (_event, projectSlug: unknown) => {
    if (typeof projectSlug !== 'string' || !projectSlug.trim()) {
      throw new Error('project slug is required')
    }
    return runCodexMemoryTargetsWorker(projectSlug)
  })
  ipcMain.handle('rules.memories.publishCodexProjectRules', (_event, value: unknown) => {
    if (!value || typeof value !== 'object') {
      throw new Error('invalid Codex project memory publish request')
    }
    const {
      projectSlug,
      workingDirectory,
      ruleIds,
      expectedRevision,
      expectedContractRevision,
    } = value as {
      projectSlug?: unknown
      workingDirectory?: unknown
      ruleIds?: unknown
      expectedRevision?: unknown
      expectedContractRevision?: unknown
    }
    if (typeof projectSlug !== 'string' || !projectSlug.trim()) {
      throw new Error('project slug is required')
    }
    if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) {
      throw new Error('Codex project working directory is required')
    }
    if (
      !Array.isArray(ruleIds)
      || ruleIds.length === 0
      || ruleIds.some((id) => typeof id !== 'string' || !id.trim())
    ) {
      throw new Error('project rule ids are required')
    }
    if (expectedRevision !== null && typeof expectedRevision !== 'string') {
      throw new Error('invalid Codex project memory revision')
    }
    if (typeof expectedContractRevision !== 'string') {
      throw new Error('Codex project memory contract revision is required')
    }
    return publishProjectRulesToCodexMemory({
      projectSlug,
      workingDirectory,
      ruleIds: ruleIds as string[],
      expectedRevision: expectedRevision as string | null,
      expectedContractRevision,
    })
  })

  ipcMain.handle('rules.output', (_event, projectSlug: unknown) => {
    if (typeof projectSlug !== 'string' || !projectSlug.trim()) {
      throw new Error('project slug is required')
    }
    const paths: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      originalLog(...args)
      const match = /^(?:已写入|未变化)：(.+)$/.exec(args.map(String).join(' '))
      if (match) paths.push(match[1])
    }
    try {
      runRulesOutput({ project: projectSlug })
      return paths
    } finally {
      console.log = originalLog
    }
  })
  ipcMain.handle('rules.projectOutput.read', (_event, projectSlug: unknown) => {
    if (typeof projectSlug !== 'string' || !projectSlug.trim()) {
      throw new Error('project slug is required')
    }
    return readProjectRulesOutput(projectSlug)
  })
  ipcMain.handle('rules.projectMemory.status', (_event, projectSlug: unknown) => {
    if (typeof projectSlug !== 'string' || !projectSlug.trim()) {
      throw new Error('project slug is required')
    }
    return runProjectMemoryStatusWorker(projectSlug)
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
  ipcMain.handle('rules.batchUpdateStatus', (_event, ids: unknown, status: unknown) => {
    if (
      !Array.isArray(ids)
      || ids.length === 0
      || ids.some((id) => typeof id !== 'string' || !id.trim())
    ) {
      throw new Error('candidate ids are required')
    }
    if (status !== 'accepted' && status !== 'rejected') {
      throw new Error(`unsupported candidate status: ${String(status)}`)
    }
    return updateRuleCandidatesStatus(ids, status)
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

function validateNativeChatSendRequest(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid chat send request')
  }
  const request = value as Record<string, unknown>
  if (!isLlmProvider(request.provider)) {
    throw new Error('invalid chat provider')
  }
  const pastedTextAttachments = validatePastedTextAttachments(request.pastedTextAttachments)
  if (pastedTextAttachments.length > 0 && request.provider !== 'codex') {
    throw new Error('pasted text attachments require Codex')
  }
  if (
    typeof request.message !== 'string'
    || (!request.message.trim() && pastedTextAttachments.length === 0)
  ) {
    throw new Error('chat message is required')
  }
  if (request.chatId !== undefined && (
    typeof request.chatId !== 'string' || !request.chatId.trim()
  )) {
    throw new Error('chat id must be a non-empty string')
  }
  if (!request.config || typeof request.config !== 'object' || Array.isArray(request.config)) {
    throw new Error('chat turn config is required')
  }
  const config = request.config as Record<string, unknown>
  if (!isLlmEffort(config.effort)) throw new Error('chat effort is unsupported')
  if (typeof config.fastMode !== 'boolean') throw new Error('chat fastMode must be boolean')
  if (config.thinkingOptionId !== undefined && (
    typeof config.thinkingOptionId !== 'string' || !config.thinkingOptionId.trim()
  )) throw new Error('chat thinking option must be a non-empty string')
  if (config.model !== undefined && (
    typeof config.model !== 'string' || !config.model.trim()
  )) {
    throw new Error('chat model must be a non-empty string')
  }
  if (
    request.sessionEvidenceMode !== undefined
    && request.sessionEvidenceMode !== 'auto'
    && request.sessionEvidenceMode !== 'complete'
    && request.sessionEvidenceMode !== 'targeted'
  ) {
    throw new Error('chat session evidence mode is unsupported')
  }
  return {
    ...(typeof request.chatId === 'string' ? { chatId: request.chatId } : {}),
    provider: request.provider,
    message: request.message,
    config: {
      ...(typeof config.model === 'string' ? { model: config.model } : {}),
      effort: config.effort,
      fastMode: config.fastMode,
      ...(typeof config.thinkingOptionId === 'string'
        ? { thinkingOptionId: config.thinkingOptionId.trim() }
        : {}),
    },
    ...(request.sessionContext !== undefined
      ? { sessionContext: validateSessionReferences(request.sessionContext) }
      : {}),
    ...(typeof request.sessionEvidenceMode === 'string'
      ? { sessionEvidenceMode: request.sessionEvidenceMode }
      : {}),
    ...(pastedTextAttachments.length > 0 ? { pastedTextAttachments } : {}),
  }
}

function validateSessionContextQuery(value: unknown) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid session context query')
  }
  const query = value as Record<string, unknown>
  for (const key of ['project', 'from', 'to', 'cursor']) {
    if (query[key] !== undefined && typeof query[key] !== 'string') {
      throw new Error(`session context ${key} must be a string`)
    }
  }
  if (query.limit !== undefined && !Number.isInteger(query.limit)) {
    throw new Error('session context limit must be an integer')
  }
  return {
    ...(typeof query.project === 'string' ? { project: query.project } : {}),
    ...(typeof query.from === 'string' && query.from ? { from: query.from } : {}),
    ...(typeof query.to === 'string' && query.to ? { to: query.to } : {}),
    ...(typeof query.cursor === 'string' && query.cursor ? { cursor: query.cursor } : {}),
    ...(typeof query.limit === 'number' ? { limit: query.limit } : {}),
  }
}

function validateChatLifecycleRequest(value: unknown, requireTitle = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid chat lifecycle request')
  }
  const request = value as Record<string, unknown>
  if (typeof request.chatId !== 'string' || !request.chatId.trim()) {
    throw new Error('chat id is required')
  }
  if (requireTitle && (typeof request.title !== 'string' || !request.title.trim())) {
    throw new Error('chat title is required')
  }
  return {
    chatId: request.chatId,
    title: typeof request.title === 'string' ? request.title : '',
  }
}

function validateNativeChatToolReadRequest(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid tool read request')
  }
  const request = value as Record<string, unknown>
  if (typeof request.chatId !== 'string' || !request.chatId.trim()) {
    throw new Error('chat id is required')
  }
  if (typeof request.itemId !== 'string' || !request.itemId.trim()) {
    throw new Error('tool item id is required')
  }
  const cursor = request.cursor ?? 0
  const limit = request.limit ?? 8192
  if (!Number.isInteger(cursor) || Number(cursor) < 0) {
    throw new Error('tool cursor must be a non-negative integer')
  }
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 65536) {
    throw new Error('tool limit must be between 1 and 65536')
  }
  return {
    chatId: request.chatId,
    itemId: request.itemId,
    cursor: Number(cursor),
    limit: Number(limit),
  }
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

function runProjectSessionsWorker(slug: string): Promise<ProjectSessionMetadata[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(import.meta.dirname, 'project-sessions-worker.js'), {
      workerData: { slug },
    })
    let settled = false

    worker.once('message', (message: unknown) => {
      settled = true
      if (
        message
        && typeof message === 'object'
        && 'type' in message
        && message.type === 'done'
        && 'sessions' in message
      ) {
        resolve(message.sessions as ProjectSessionMetadata[])
        return
      }
      const errorMessage = message
        && typeof message === 'object'
        && 'message' in message
        && typeof message.message === 'string'
        ? message.message
        : 'Project sessions worker returned an invalid response'
      reject(new Error(errorMessage))
    })
    worker.once('error', (error) => {
      settled = true
      reject(error)
    })
    worker.once('exit', (code) => {
      if (!settled) {
        reject(new Error(`Project sessions worker exited before completion (${code})`))
      }
    })
  })
}

function runCodexMemoryTargetsWorker(
  projectSlug: string,
): Promise<CodexProjectMemoryPublishTarget[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(import.meta.dirname, 'codex-memory-targets-worker.js'), {
      workerData: { projectSlug },
    })
    let settled = false

    worker.once('message', (message: unknown) => {
      settled = true
      if (
        message
        && typeof message === 'object'
        && 'type' in message
        && message.type === 'done'
        && 'targets' in message
      ) {
        resolve(message.targets as CodexProjectMemoryPublishTarget[])
        return
      }
      const errorMessage = message
        && typeof message === 'object'
        && 'message' in message
        && typeof message.message === 'string'
        ? message.message
        : 'Codex memory targets worker returned an invalid response'
      reject(new Error(errorMessage))
    })
    worker.once('error', (error) => {
      settled = true
      reject(error)
    })
    worker.once('exit', (code) => {
      if (!settled) {
        reject(new Error(`Codex memory targets worker exited before completion (${code})`))
      }
    })
  })
}

interface ProjectMemoryPublicationStatusResult {
  projectSlug: string
  claude: ClaudeProjectMemoryPublicationStatus
  codex: CodexProjectMemoryPublicationStatus
}

function runProjectMemoryStatusWorker(
  projectSlug: string,
): Promise<ProjectMemoryPublicationStatusResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(import.meta.dirname, 'project-memory-status-worker.js'), {
      workerData: { projectSlug },
    })
    let settled = false

    worker.once('message', (message: unknown) => {
      settled = true
      if (
        message
        && typeof message === 'object'
        && 'type' in message
        && message.type === 'done'
        && 'status' in message
      ) {
        resolve(message.status as ProjectMemoryPublicationStatusResult)
        return
      }
      const errorMessage = message
        && typeof message === 'object'
        && 'message' in message
        && typeof message.message === 'string'
        ? message.message
        : 'Project memory status worker returned an invalid response'
      reject(new Error(errorMessage))
    })
    worker.once('error', (error) => {
      settled = true
      reject(error)
    })
    worker.once('exit', (code) => {
      if (!settled) {
        reject(new Error(`Project memory status worker exited before completion (${code})`))
      }
    })
  })
}

function runSessionEvidenceContextWorker(
  sessionId: string,
  messageIndex: number,
): Promise<SessionEvidenceContext> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(import.meta.dirname, 'session-preview-worker.js'), {
      workerData: { sessionId, messageIndex },
    })
    let settled = false

    worker.once('message', (message: unknown) => {
      settled = true
      if (
        message
        && typeof message === 'object'
        && 'type' in message
        && message.type === 'done'
        && 'context' in message
      ) {
        resolve(message.context as SessionEvidenceContext)
        return
      }
      const errorMessage = message
        && typeof message === 'object'
        && 'message' in message
        && typeof message.message === 'string'
        ? message.message
        : 'Session evidence worker returned an invalid response'
      reject(new Error(errorMessage))
    })
    worker.once('error', (error) => {
      settled = true
      reject(error)
    })
    worker.once('exit', (code) => {
      if (!settled) {
        reject(new Error(`Session evidence worker exited before completion (${code})`))
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
      model: config.model ?? null,
      effort: config.effort,
      fastMode: config.fastMode ?? false,
    }
  }
  if (!value || typeof value !== 'object') throw new Error('invalid generation request')
  const request = value as {
    mode?: unknown
    projects?: unknown
    provider?: unknown
    model?: unknown
    effort?: unknown
    fastMode?: unknown
    thinkingOptionId?: unknown
  }
  const provider = request.provider ?? config.provider
  const model = request.model === undefined
    ? provider === config.provider ? config.model ?? null : null
    : request.model
  const effort = request.effort ?? config.effort
  const fastMode = request.fastMode ?? config.fastMode ?? false
  const thinkingOptionId = request.thinkingOptionId
  if (!isLlmProvider(provider) || !getProviderCapabilities(provider).supportsStructuredOutput) {
    throw new Error('generation provider must support structured output')
  }
  if (config.providers?.[provider]?.enabled === false) {
    throw new Error('generation provider is disabled')
  }
  if (
    model !== null
    && (
      typeof model !== 'string'
      || !model.trim()
      || model.length > 200
      || /[\u0000-\u001f\u007f]/.test(model)
    )
  ) {
    throw new Error('generation model must be null or a non-empty string')
  }
  if (!isLlmEffort(effort)) {
    throw new Error('generation effort is unsupported')
  }
  if (typeof fastMode !== 'boolean') {
    throw new Error('generation fastMode must be boolean')
  }
  if (thinkingOptionId !== undefined && (
    typeof thinkingOptionId !== 'string' || !thinkingOptionId.trim()
  )) throw new Error('generation thinking option must be a non-empty string')
  const options: {
    provider: LlmProvider
    model: string | null
    effort: LlmEffort
    fastMode: boolean
    thinkingOptionId?: string
  } = {
    provider,
    model: typeof model === 'string' ? model.trim() : null,
    effort,
    fastMode,
    ...(typeof thinkingOptionId === 'string'
      ? { thinkingOptionId: thinkingOptionId.trim() }
      : {}),
  }
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

function broadcastNativeChatChanged(chatId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('chat.changed', { chatId })
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

function broadcastNativeChatEvent(payload: {
  chatId: string
  event: import('./chat-runtime.js').NativeChatEvent
}): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send('chat.event', payload)
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
