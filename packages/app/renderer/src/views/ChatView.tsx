import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClipboardEvent as ReactClipboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react'
import { Alert, Button, Card, Chip, ListBox, Modal, Select, Spinner, Switch, Tooltip } from '@heroui/react'
import MarkdownRender from 'markstream-react'
import { useTranslation } from 'react-i18next'
import {
  Brain,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  Eye,
  FilePenLine,
  FileText,
  History,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Square,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { currentLocale } from '../i18n'
import { formatDateTime, formatNumber } from '../i18n/format'
import type {
  ChatThread,
  ChatMessage,
  ChatThreadSummary,
  GenerationChatThread,
  GenerationHistoryEntry,
  GenerationStartResult,
  NativeChatEvent,
  NativeInteractionRequest,
  NativeToolActivity,
  NativeToolItemPage,
  NativeTurnTimelineItem,
  ProviderId,
  ProviderSnapshot,
  Project,
  RunCancelResult,
  NativeSessionReference,
  SessionContextItem,
  SessionContextPage,
} from '../types'
import {
  assistantTurnStartedAt,
  canRegenerate,
  createProviderSnapshotSync,
  formatElapsed,
  mergeTimelineActivities,
  shouldFollowStream,
  toggleAvailableSessionSelection,
  virtualWindowRange,
  visibleProjectResponses,
} from './chat-view-model'
import {
  readStoredContextPaneOpen,
  writeStoredContextPaneOpen,
} from './chat-layout-preference'
import { ChatSkillPicker } from './ChatSkillPicker'
import type { ChatSkillOption } from './chat-skill-picker-model'
import {
  composeMessageWithSkills,
  consumeSkillPickerTrigger,
  updateRecentSkillNames,
} from './chat-skill-picker-model'
import {
  groupNativeTurnTimeline,
  mergeLiveTimeline,
  normalizeThinkingMarkdown,
  shouldShowNativeChatStop,
  toolActivityCounts,
} from './chat-timeline-model'
import {
  createComposerTextAttachment,
  PASTED_TEXT_RESTORE_LIMIT,
  type ComposerTextAttachment,
} from './chat-pasted-text-model'

interface QueuedChatTurn {
  message: string
  provider: ProviderId
  config: {
    model?: string
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    fastMode: boolean
    thinkingOptionId?: string
  }
  sessionContext?: NativeSessionReference[]
  pastedTextAttachments?: ComposerTextAttachment[]
}

interface ChatHistoryItem {
  id: string
  thread?: ChatThreadSummary
  legacy?: GenerationHistoryEntry
}

const CHAT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export function ChatView({
  initialThreadId,
  onOpenGeneratedRules,
}: {
  initialThreadId?: string | null
  onOpenGeneratedRules: (runId: string) => void
}) {
  const { t } = useTranslation('chat')
  const [threads, setThreads] = useState<ChatThreadSummary[]>([])
  const [history, setHistory] = useState<GenerationHistoryEntry[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(initialThreadId ?? null)
  const [thread, setThread] = useState<ChatThread | null>(null)
  const [legacy, setLegacy] = useState<GenerationHistoryEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errorTitle, setErrorTitle] = useState<'loadError' | 'actionError'>('loadError')
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [composer, setComposer] = useState('')
  const [pastedTextAttachments, setPastedTextAttachments] = useState<ComposerTextAttachment[]>([])
  const [isSending, setIsSending] = useState(false)
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<(typeof CHAT_EFFORTS)[number]>('high')
  const [fastMode, setFastMode] = useState(false)
  const [thinkingOptionId, setThinkingOptionId] = useState('')
  const [pendingInteraction, setPendingInteraction] = useState<{
    chatId: string
    request: NativeInteractionRequest
  } | null>(null)
  const [interactionAnswers, setInteractionAnswers] = useState<Record<string, string[]>>({})
  const [providerSnapshot, setProviderSnapshot] = useState<ProviderSnapshot>({ entries: [], refreshing: false })
  const [skills, setSkills] = useState<ChatSkillOption[]>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [recentSkills, setRecentSkills] = useState<string[]>(() => readRecentSkills(window.localStorage))
  const [liveTimeline, setLiveTimeline] = useState<NativeTurnTimelineItem[]>([])
  const [liveStartedAt, setLiveStartedAt] = useState<string | null>(null)
  const [liveUsage, setLiveUsage] = useState<{ usedTokens: number; maxTokens: number } | null>(null)
  const [queuedCount, setQueuedCount] = useState(0)
  const [projects, setProjects] = useState<Project[]>([])
  const [contextProject, setContextProject] = useState('all')
  const [contextFrom, setContextFrom] = useState('')
  const [contextTo, setContextTo] = useState('')
  const [contextItems, setContextItems] = useState<SessionContextItem[]>([])
  const [contextCursor, setContextCursor] = useState<string | null>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [selectedContext, setSelectedContext] = useState<NativeSessionReference[]>([])
  const [selectedContextItems, setSelectedContextItems] = useState<SessionContextItem[]>([])
  const [historyMode, setHistoryMode] = useState<'active' | 'archived'>('active')
  const [historyPaneOpen, setHistoryPaneOpen] = useState(true)
  const [contextPaneOpen, setContextPaneOpen] = useState(
    () => readStoredContextPaneOpen(window.localStorage),
  )
  const [compactContextOpen, setCompactContextOpen] = useState(false)
  const [compactLayout, setCompactLayout] = useState(false)
  const [composerOptionsOpen, setComposerOptionsOpen] = useState(false)
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [managementOpen, setManagementOpen] = useState(false)
  const [historyContextMenu, setHistoryContextMenu] = useState<{
    item: ChatHistoryItem
    x: number
    y: number
  } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirmThread, setDeleteConfirmThread] = useState<Extract<ChatThread, { version: 2 }> | null>(null)
  const selectedIdRef = useRef<string | null>(selectedId)
  const liveChatIdRef = useRef<string | null>(null)
  const sendingRef = useRef(false)
  const queueRef = useRef<QueuedChatTurn[]>([])
  const preserveDraftContextRef = useRef(false)
  const conversationRef = useRef<HTMLElement | null>(null)
  const followStreamRef = useRef(true)
  const composerOptionsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 1279px)')
    const syncLayout = () => setCompactLayout(mediaQuery.matches)
    syncLayout()
    mediaQuery.addEventListener('change', syncLayout)
    return () => mediaQuery.removeEventListener('change', syncLayout)
  }, [])

  useEffect(() => {
    const hasEscapableOverlay =
      composerOptionsOpen || (compactLayout && (historyPaneOpen || compactContextOpen))
    if (!hasEscapableOverlay) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setComposerOptionsOpen(false)
      if (compactLayout) {
        setHistoryPaneOpen(false)
        setCompactContextOpen(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [compactContextOpen, compactLayout, composerOptionsOpen, historyPaneOpen])

  useEffect(() => {
    if (!composerOptionsOpen) return
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (!composerOptionsRef.current?.contains(event.target as Node)) setComposerOptionsOpen(false)
    }
    window.addEventListener('mousedown', closeOnOutsidePress)
    return () => window.removeEventListener('mousedown', closeOnOutsidePress)
  }, [composerOptionsOpen])

  useEffect(() => {
    let current = true
    const providerSnapshotSync = createProviderSnapshotSync(setProviderSnapshot)
    const onProvidersUpdated = (value: unknown) => providerSnapshotSync.receiveUpdate(value)

    window.api.onEvent('settings.providers.updated', onProvidersUpdated)
    void Promise.all([
      window.api.invoke<ProviderSnapshot>('settings.providers.snapshot'),
      window.api.invoke<{
        provider: ProviderId
        model?: string
        effort: (typeof CHAT_EFFORTS)[number]
        fastMode?: boolean
      }>('settings.load'),
    ]).then(([snapshot, config]) => {
      if (!current) return
      providerSnapshotSync.receiveInitial(snapshot)
      setProvider(config.provider)
      setModel(config.model ?? '')
      setEffort(config.effort)
      setFastMode(config.fastMode === true)
    }).catch(() => undefined)

    return () => {
      current = false
      providerSnapshotSync.stop()
      window.api.offEvent('settings.providers.updated', onProvidersUpdated)
    }
  }, [])

  useEffect(() => {
    void window.api.invoke<Project[]>('projects.list').then(setProjects).catch(() => setProjects([]))
  }, [])

  useEffect(() => {
    if (thread?.kind !== 'native-chat') return
    setProvider(thread.provider)
    setModel(thread.defaultTurnConfig.model ?? '')
    setEffort(thread.defaultTurnConfig.effort)
    setFastMode(thread.defaultTurnConfig.fastMode)
    setThinkingOptionId(thread.defaultTurnConfig.thinkingOptionId ?? '')
    setRenameValue(thread.title)
  }, [thread?.id])

  const sessionContextRevision = thread?.kind === 'native-chat'
    ? thread.sessionContext.revision
    : null

  useEffect(() => {
    if (thread?.kind !== 'native-chat') return
    setSelectedContext(thread.sessionContext.selected)
  }, [thread?.id, sessionContextRevision])

  useEffect(() => {
    if (thread || legacy) return
    if (preserveDraftContextRef.current) {
      preserveDraftContextRef.current = false
      return
    }
    setSelectedContext([])
  }, [thread?.id, legacy?.id])

  useEffect(() => {
    if (selectedContext.length === 0) {
      setSelectedContextItems([])
      return
    }
    void window.api.invoke<SessionContextItem[]>('chat.context.resolve', selectedContext)
      .then(setSelectedContextItems)
      .catch(() => setSelectedContextItems(selectedContext.map((reference) => ({
        ...reference, displayName: `${reference.agent} session`, slug: 'unknown', updatedAt: '',
        status: 'missing', sourceAvailable: false,
      }))))
  }, [selectedContext])

  const loadContextSessions = useCallback(async (append = false) => {
    setContextLoading(true)
    try {
      const page = await window.api.invoke<SessionContextPage>('chat.context.query', {
        project: contextProject,
        ...(contextFrom ? { from: localDateBoundary(contextFrom, false) } : {}),
        ...(contextTo ? { to: localDateBoundary(contextTo, true) } : {}),
        ...(append && contextCursor ? { cursor: contextCursor } : {}),
        limit: 100,
      })
      setContextItems((current) => append ? mergeSessionContextItems(current, page.items) : page.items)
      setContextCursor(page.nextCursor)
    } catch {
      if (!append) setContextItems([])
      setContextCursor(null)
    } finally {
      setContextLoading(false)
    }
  }, [contextCursor, contextFrom, contextProject, contextTo])

  useEffect(() => {
    void loadContextSessions(false)
  }, [contextProject, contextFrom, contextTo])

  useEffect(() => {
    void window.api.invoke<ChatSkillOption[]>('chat.skills', provider)
      .then((available) => {
        setSkills(available)
        const availableNames = new Set(available.map((skill) => skill.name))
        setSelectedSkills((current) => current.filter((name) => availableNames.has(name)))
      })
      .catch(() => setSkills([]))
  }, [provider])

  useEffect(() => {
    const onChatEvent = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const envelope = value as { chatId?: unknown; event?: unknown }
      if (typeof envelope.chatId !== 'string' || !isNativeChatEvent(envelope.event)) return
      const event = envelope.event
      if (selectedIdRef.current && selectedIdRef.current !== envelope.chatId) return
      if (!selectedIdRef.current && !sendingRef.current) return
      liveChatIdRef.current = envelope.chatId
      if (event.type === 'usage') {
        setLiveUsage(event.contextUsage)
      } else if (event.type === 'interaction_request') {
        setPendingInteraction({ chatId: envelope.chatId, request: event.request })
        setInteractionAnswers({})
      } else {
        setLiveTimeline((current) => mergeLiveTimeline(current, event))
      }
    }
    window.api.onEvent('chat.event', onChatEvent)
    return () => window.api.offEvent('chat.event', onChatEvent)
  }, [])

  const loadIndex = useCallback(async (preferredId?: string | null) => {
    const [threadRows, historyRows] = await Promise.all([
      window.api.invoke<ChatThreadSummary[]>('chat.list'),
      window.api.invoke<GenerationHistoryEntry[]>('rules.generate.history'),
    ])
    setThreads(threadRows)
    setHistory(historyRows)
    const current = preferredId ?? selectedIdRef.current
    const next = current
      ?? threadRows[0]?.id
      ?? historyRows[0]?.id
      ?? null
    setSelectedId(next)
    selectedIdRef.current = next
    return { threadRows, historyRows, selectedId: next }
  }, [])

  const loadSelected = useCallback(async (
    id: string | null,
    threadRows: ChatThreadSummary[],
    historyRows: GenerationHistoryEntry[],
  ) => {
    if (!id) {
      setThread(null)
      setLegacy(null)
      return
    }
    if (threadRows.some((item) => item.id === id)) {
      const restored = await window.api.invoke<ChatThread | null>('chat.read', id)
      setThread(restored)
      setLegacy(null)
      return
    }
    setThread(null)
    setLegacy(historyRows.find((item) => item.id === id) ?? null)
  }, [])

  const refresh = useCallback(async (preferredId?: string | null) => {
    try {
      const result = await loadIndex(preferredId)
      await loadSelected(result.selectedId, result.threadRows, result.historyRows)
      setError(null)
    } catch (reason: unknown) {
      setErrorTitle('loadError')
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [loadIndex, loadSelected])

  useEffect(() => {
    void refresh(initialThreadId)
  }, [initialThreadId, refresh])

  useEffect(() => {
    followStreamRef.current = true
  }, [selectedId])

  useEffect(() => {
    if (!followStreamRef.current || !conversationRef.current) return
    const frame = requestAnimationFrame(() => {
      const element = conversationRef.current
      if (!element) return
      element.scrollTo({ top: element.scrollHeight })
    })
    return () => cancelAnimationFrame(frame)
  }, [thread?.messages.length, thread?.status, thread?.kind === 'rules-generation'
    ? thread.activities.length
    : 0])

  useEffect(() => {
    const onGenerationChange = (value: unknown) => {
      if (
        value
        && typeof value === 'object'
        && 'event' in value
        && value.event
        && typeof value.event === 'object'
        && 'kind' in value.event
        && value.event.kind === 'assistant_delta'
      ) {
        return
      }
      void refresh()
    }
    for (const channel of [
      'generate.progress',
      'generate.event',
      'generate.done',
      'generate.cancelled',
      'generate.failed',
    ]) {
      window.api.onEvent(channel, onGenerationChange)
    }
    return () => {
      for (const channel of [
        'generate.progress',
        'generate.event',
        'generate.done',
        'generate.cancelled',
        'generate.failed',
      ]) {
        window.api.offEvent(channel, onGenerationChange)
      }
    }
  }, [refresh])

  useEffect(() => {
    const onChanged = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('chatId' in value)) return
      const chatId = (value as { chatId?: unknown }).chatId
      if (typeof chatId !== 'string') return
      if (chatId === selectedIdRef.current) void refresh(chatId)
      else if (!selectedIdRef.current && sendingRef.current) {
        selectedIdRef.current = chatId
        setSelectedId(chatId)
        void refresh(chatId)
      }
    }
    window.api.onEvent('chat.changed', onChanged)
    return () => window.api.offEvent('chat.changed', onChanged)
  }, [refresh])

  const items = useMemo(() => {
    const persistedIds = new Set(threads.map((item) => item.id))
    return [
      ...threads.map((item) => ({ id: item.id, thread: item, legacy: undefined })),
      ...history
        .filter((item) => !persistedIds.has(item.id))
        .map((item) => ({ id: item.id, thread: undefined, legacy: item })),
    ]
  }, [history, threads])
  const visibleItems = useMemo(() => items.filter((item) => {
    if (!item.thread || item.thread.version === 1) return historyMode === 'active'
    return historyMode === 'archived' ? Boolean(item.thread.archivedAt) : !item.thread.archivedAt
  }), [historyMode, items])

  async function stopGeneration(): Promise<void> {
    if (!thread || thread.kind !== 'rules-generation'
      || (thread.status !== 'running' && thread.status !== 'cancelling')) return
    try {
      await window.api.invoke<RunCancelResult>(
        'rules.generate.cancel',
        { runId: thread.runId },
      )
      await refresh(thread.id)
    } catch (reason: unknown) {
      setErrorTitle('actionError')
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function regenerate(): Promise<void> {
    if (!thread || thread.kind !== 'rules-generation'
      || !canRegenerate(thread.status) || isRegenerating) return
    setIsRegenerating(true)
    setError(null)
    try {
      const result = await window.api.invoke<GenerationStartResult>(
        'rules.generate',
        thread.request,
      )
      if (!result.started) {
        setErrorTitle('actionError')
        setError(t('generationAlreadyRunning'))
        return
      }
      await refresh(result.runId)
    } catch (reason: unknown) {
      setErrorTitle('actionError')
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setIsRegenerating(false)
    }
  }

  function selectThread(id: string): void {
    if (compactLayout) setHistoryPaneOpen(false)
    setSelectedId(id)
    selectedIdRef.current = id
    void refresh(id)
  }

  function openHistoryContextMenu(
    event: ReactMouseEvent,
    item: ChatHistoryItem,
  ): void {
    if (item.thread?.version !== 2) return
    event.preventDefault()
    setHistoryContextMenu({
      item,
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 170),
    })
  }

  async function openHistoryManagement(item: ChatHistoryItem): Promise<void> {
    if (item.thread?.version !== 2) return
    setHistoryContextMenu(null)
    setSelectedId(item.id)
    selectedIdRef.current = item.id
    await refresh(item.id)
    setRenameValue(item.thread.title)
    setManagementOpen(true)
  }

  async function setHistoryPinned(item: ChatHistoryItem, pinned: boolean): Promise<void> {
    if (item.thread?.version !== 2) return
    setHistoryContextMenu(null)
    try {
      await window.api.invoke(pinned ? 'chat.pin' : 'chat.unpin', { chatId: item.id })
      await refresh(selectedIdRef.current)
    } catch (reason: unknown) {
      setErrorTitle('actionError')
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function setHistoryArchived(item: ChatHistoryItem, archived: boolean): Promise<void> {
    if (item.thread?.version !== 2) return
    if (archived && item.thread.status === 'running' && !window.confirm(t('archiveRunningConfirm'))) {
      return
    }
    setHistoryContextMenu(null)
    setLifecycleBusy(true)
    try {
      await window.api.invoke(archived ? 'chat.archive' : 'chat.unarchive', { chatId: item.id })
      setHistoryMode(archived ? 'archived' : 'active')
      await refresh(selectedIdRef.current)
    } catch (reason: unknown) {
      setErrorTitle('actionError')
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLifecycleBusy(false)
    }
  }

  function startDraft(): void {
    if (compactLayout) setHistoryPaneOpen(false)
    preserveDraftContextRef.current = false
    setSelectedId(null)
    selectedIdRef.current = null
    setThread(null)
    setLegacy(null)
    setComposer('')
    setPastedTextAttachments([])
    setSelectedSkills([])
    setLiveTimeline([])
    setLiveStartedAt(null)
    setLiveUsage(null)
    liveChatIdRef.current = null
    setError(null)
  }

  function continueAsNewChat(): void {
    if (thread?.kind !== 'native-chat') return
    const source = thread
    preserveDraftContextRef.current = true
    setSelectedId(null)
    selectedIdRef.current = null
    setThread(null)
    setLegacy(null)
    setProvider(source.provider)
    setModel(source.defaultTurnConfig.model ?? '')
    setEffort(source.defaultTurnConfig.effort)
    setFastMode(source.defaultTurnConfig.fastMode)
    setThinkingOptionId(source.defaultTurnConfig.thinkingOptionId ?? '')
    setSelectedContext(source.sessionContext.selected.map((reference) => ({ ...reference })))
    setComposer('')
    setPastedTextAttachments([])
    setSelectedSkills([])
    setError(null)
  }

  function sendChatMessage(): void {
    const rawMessage = composer.trim()
    if (!rawMessage && pastedTextAttachments.length === 0) return
    if (thread && thread.kind !== 'native-chat') return
    const usedSkills = [...selectedSkills]
    const message = composeMessageWithSkills(rawMessage, usedSkills)
    const turn: QueuedChatTurn = {
      message,
      provider: thread?.provider ?? provider,
      config: {
        ...(model ? { model } : {}), effort, fastMode,
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
      },
      ...(!thread ? { sessionContext: selectedContext.map((reference) => ({ ...reference })) } : {}),
      ...(pastedTextAttachments.length > 0
        ? { pastedTextAttachments: pastedTextAttachments.map((attachment) => ({ ...attachment })) }
        : {}),
    }
    setComposer('')
    setPastedTextAttachments([])
    setSelectedSkills([])
    if (usedSkills.length > 0) {
      setRecentSkills((current) => {
        const next = updateRecentSkillNames(current, usedSkills)
        writeRecentSkills(window.localStorage, next)
        return next
      })
    }
    if (sendingRef.current) {
      queueRef.current.push(turn)
      setQueuedCount(queueRef.current.length)
      return
    }
    void drainChatQueue(turn)
  }

  async function drainChatQueue(first: QueuedChatTurn): Promise<void> {
    sendingRef.current = true
    setIsSending(true)
    setError(null)
    setLiveTimeline([])
    setLiveStartedAt(new Date().toISOString())
    let next: QueuedChatTurn | undefined = first
    let currentChatId = thread?.kind === 'native-chat' ? thread.id : undefined
    try {
      while (next) {
        const result = await window.api.invoke<{ chatId: string; nativeSessionId: string }>(
          'chat.send',
          {
            ...(currentChatId ? { chatId: currentChatId } : {}),
            provider: next.provider,
            message: next.message,
            config: next.config,
            ...(next.sessionContext ? { sessionContext: next.sessionContext } : {}),
            ...(next.pastedTextAttachments
              ? { pastedTextAttachments: next.pastedTextAttachments }
              : {}),
          },
        )
        currentChatId = result.chatId
        selectedIdRef.current = result.chatId
        setSelectedId(result.chatId)
        await refresh(result.chatId)
        setLiveTimeline([])
        next = queueRef.current.shift()
        setLiveStartedAt(next ? new Date().toISOString() : null)
        setQueuedCount(queueRef.current.length)
      }
    } catch (reason: unknown) {
      setErrorTitle('actionError')
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      sendingRef.current = false
      setIsSending(false)
    }
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    const activeProvider = thread?.kind === 'native-chat' ? thread.provider : provider
    if (activeProvider !== 'codex') return
    const text = event.clipboardData.getData('text/plain')
    const attachment = createComposerTextAttachment(text, window.crypto.randomUUID())
    if (!attachment) return
    event.preventDefault()
    setPastedTextAttachments((current) => [...current, attachment])
  }

  function removePastedTextAttachment(id: string): void {
    setPastedTextAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }

  function restorePastedTextAttachment(id: string): void {
    const attachment = pastedTextAttachments.find((current) => current.id === id)
    if (!attachment || attachment.characterCount > PASTED_TEXT_RESTORE_LIMIT) return
    setComposer((current) => current
      ? `${current}\n${attachment.text}`
      : attachment.text)
    removePastedTextAttachment(id)
  }

  function changeProvider(nextProvider: ProviderId): void {
    if (nextProvider !== 'codex' && pastedTextAttachments.length > 0) {
      const restored = pastedTextAttachments.map((attachment) => attachment.text).join('\n\n')
      setComposer((current) => [current, restored].filter(Boolean).join('\n\n'))
      setPastedTextAttachments([])
    }
    setProvider(nextProvider)
    setModel('')
    setThinkingOptionId('')
    if (!providerSnapshot.entries.find((entry) => entry.id === nextProvider)?.capabilities.supportsFastMode) {
      setFastMode(false)
    }
  }

  async function respondToInteraction(cancelled = false): Promise<void> {
    if (!pendingInteraction) return
    await window.api.invoke('chat.interaction.respond', {
      chatId: pendingInteraction.chatId,
      requestId: pendingInteraction.request.requestId,
      answers: interactionAnswers,
      cancelled,
    })
    setPendingInteraction(null)
    setInteractionAnswers({})
  }

  async function stopChatTurn(): Promise<void> {
    const chatId = liveChatIdRef.current
      ?? (thread?.kind === 'native-chat' ? thread.id : null)
    if (!chatId) return
    await window.api.invoke('chat.interrupt', chatId)
  }

  async function updateSelectedContext(next: NativeSessionReference[]): Promise<void> {
    const canonical = canonicalSessionReferences(next)
    const previous = selectedContext
    setSelectedContext(canonical)
    if (thread?.kind !== 'native-chat') return
    try {
      const sessionContext = await window.api.invoke<Extract<ChatThread, { version: 2 }>['sessionContext']>(
        'chat.context.update', { chatId: thread.id, selected: canonical },
      )
      setThread((current) => current?.kind === 'native-chat'
        ? { ...current, sessionContext }
        : current)
    } catch (reason: unknown) {
      setSelectedContext(previous)
      setErrorTitle('actionError')
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  function selectRecentContextDays(days: number): void {
    const end = new Date()
    const start = new Date(end)
    start.setDate(start.getDate() - days + 1)
    setContextFrom(localDateValue(start))
    setContextTo(localDateValue(end))
  }

  function setContextOpen(open: boolean): void {
    if (compactLayout) {
      setCompactContextOpen(open)
      return
    }
    setContextPaneOpen(open)
    writeStoredContextPaneOpen(window.localStorage, open)
  }

  async function renameCurrentChat(): Promise<void> {
    if (thread?.kind !== 'native-chat' || !renameValue.trim() || lifecycleBusy) return
    setLifecycleBusy(true)
    try {
      await window.api.invoke('chat.rename', { chatId: thread.id, title: renameValue })
      await refresh(thread.id)
    } catch (reason: unknown) {
      setErrorTitle('actionError')
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLifecycleBusy(false)
    }
  }

  async function archiveCurrentChat(): Promise<void> {
    if (thread?.kind !== 'native-chat' || lifecycleBusy) return
    if (thread.status === 'running' && !window.confirm(t('archiveRunningConfirm'))) return
    setLifecycleBusy(true)
    try {
      await window.api.invoke('chat.archive', { chatId: thread.id })
      setHistoryMode('archived')
      await refresh(thread.id)
    } catch (reason: unknown) {
      setErrorTitle('actionError')
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLifecycleBusy(false)
    }
  }

  async function restoreCurrentChat(): Promise<void> {
    if (thread?.kind !== 'native-chat' || lifecycleBusy) return
    setLifecycleBusy(true)
    try {
      await window.api.invoke('chat.unarchive', { chatId: thread.id })
      setHistoryMode('active')
      await refresh(thread.id)
    } catch (reason: unknown) {
      setErrorTitle('actionError')
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLifecycleBusy(false)
    }
  }

  async function permanentlyDeleteChat(): Promise<void> {
    if (!deleteConfirmThread || lifecycleBusy) return
    setLifecycleBusy(true)
    try {
      await window.api.invoke('chat.delete', { chatId: deleteConfirmThread.id })
      setDeleteConfirmThread(null)
      setThread(null)
      setSelectedId(null)
      selectedIdRef.current = null
      await refresh(null)
    } catch (reason: unknown) {
      setErrorTitle('actionError')
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLifecycleBusy(false)
    }
  }

  function updateFollowState(): void {
    const element = conversationRef.current
    if (!element) return
    followStreamRef.current = shouldFollowStream({
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    })
  }

  const currentTitle = thread?.title
    ?? (legacy ? legacyTitle(legacy, t) : t('newChat'))
  let currentSubtitle = t('draft')
  if (legacy) currentSubtitle = t('legacy')
  if (thread?.kind === 'rules-generation') currentSubtitle = t('rulesRun')
  if (thread?.kind === 'native-chat') currentSubtitle = thread.provider
  const contextUsage = liveUsage
    ?? (thread?.kind === 'native-chat' ? thread.contextUsage : null)
  const contextPercent = contextUsage && contextUsage.maxTokens > 0
    ? Math.min(100, Math.round((contextUsage.usedTokens / contextUsage.maxTokens) * 100))
    : 0
  const contextUsageLabel = contextUsage
    ? formatContextUsage(contextUsage, contextPercent)
    : t('contextUnavailable')
  const showStopChatTurn = shouldShowNativeChatStop(isSending, thread)
  const contextPanelOpen = compactLayout ? compactContextOpen : contextPaneOpen
  let contextVisibilityClass = 'translate-x-0 opacity-100'
  if (compactLayout && !compactContextOpen) {
    contextVisibilityClass = 'pointer-events-none translate-x-[calc(100%+2rem)] opacity-0'
  } else if (!compactLayout && !contextPaneOpen) {
    contextVisibilityClass = 'pointer-events-none translate-x-7 opacity-0'
  }
  const overlayOpen = compactLayout && (historyPaneOpen || compactContextOpen)
  const historyContextThread = historyContextMenu?.item.thread?.version === 2
    ? historyContextMenu.item.thread
    : null
  const historyPane = (
    <aside
      aria-hidden={!historyPaneOpen}
      aria-label={t('threadRail')}
      className={`relative z-10 grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-r border-pane-border bg-pane transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none max-[1279px]:fixed max-[1279px]:bottom-0 max-[1279px]:left-0 max-[1279px]:top-12 max-[1279px]:z-40 max-[1279px]:w-72 max-[1279px]:shadow-2xl ${historyPaneOpen ? 'translate-x-0 opacity-100' : 'pointer-events-none -translate-x-6 opacity-0'}`}
      data-chat-history-pane
      inert={!historyPaneOpen}
    >
      <div className="grid gap-2.5 border-b border-border-soft p-3" data-chat-history-head>
        <div className="flex items-center gap-2">
          <strong className="text-[12px] font-[650] leading-[normal] text-pane-foreground">{t('threadRail')}</strong>
          <button
            aria-label={t('closeHistory')}
            className="ml-auto inline-grid size-[30px] place-items-center rounded-lg border-0 bg-transparent p-0 text-pane-muted hover:bg-pane-hover hover:text-pane-foreground"
            onClick={() => setHistoryPaneOpen(false)}
            type="button"
          >
            <X aria-hidden="true" size={14} />
          </button>
        </div>
        <button
          className="flex h-[34px] w-full items-center justify-center gap-[7px] rounded-[9px] border border-pane-border bg-pane-surface p-0 text-[11px] font-[620] leading-[normal] text-pane-foreground hover:bg-surface-raised"
          onClick={startDraft}
          type="button"
        >
          <Plus aria-hidden="true" size={14} />
          {t('newChat')}
        </button>
        <div className="grid grid-cols-2 gap-1" data-chat-history-tabs>
          <button
            className={`h-7 w-full min-w-0 rounded-[7px] border-0 text-[10px] font-normal leading-[normal] transition-colors focus-visible:bg-surface-hover focus-visible:text-pane-foreground ${historyMode === 'active' ? 'bg-surface-raised text-pane-foreground' : 'bg-transparent text-pane-muted hover:bg-surface-hover hover:text-pane-foreground'}`}
            onClick={() => setHistoryMode('active')}
            type="button"
          >
            {t('activeChats')}
          </button>
          <button
            className={`h-7 w-full min-w-0 rounded-[7px] border-0 text-[10px] font-normal leading-[normal] transition-colors focus-visible:bg-surface-hover focus-visible:text-pane-foreground ${historyMode === 'archived' ? 'bg-surface-raised text-pane-foreground' : 'bg-transparent text-pane-muted hover:bg-surface-hover hover:text-pane-foreground'}`}
            onClick={() => setHistoryMode('archived')}
            type="button"
          >
            {t('archivedChats')}
          </button>
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto p-2">
        {loading ? <div className="grid place-items-center py-12"><Spinner color="accent" /></div> : visibleItems.length === 0 ? (
          <p className="px-3 py-8 text-xs leading-5 text-muted">{t('empty')}</p>
        ) : visibleItems.map((item) => {
          const status = item.thread?.status ?? item.legacy?.status ?? 'completed'
          const active = item.id === selectedId
          return (
            <button aria-current={active ? 'page' : undefined} className={`group grid w-full gap-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface-hover ${active ? 'bg-primary-soft' : ''}`} key={item.id} onClick={() => selectThread(item.id)} onContextMenu={(event) => openHistoryContextMenu(event, item)} title={item.thread?.version === 2 ? t('historyContextHint') : undefined} type="button">
              <span className="flex min-w-0 items-center gap-1.5">
                {item.thread?.version === 2 && item.thread.pinnedAt && <Pin aria-label={t('pinned')} className="shrink-0 text-success" size={11} />}
                <strong className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{item.thread ? item.thread.kind === 'native-chat' ? item.thread.title : threadTitle(item.thread.request, t) : legacyTitle(item.legacy!, t)}</strong>
              </span>
              <span className="flex items-center justify-between gap-2 text-[10px] text-muted"><span>{formatDateTime(historyItemUpdatedAt(item), currentLocale())} · {t(`status.${status}`, { defaultValue: status })}</span>{!item.thread && <span>{t('legacy')}</span>}</span>
            </button>
          )
        })}
      </div>
    </aside>
  )

  return (
    <section aria-label={t('title')} className="relative h-screen min-h-0 overflow-hidden bg-background">
      <div
        className={`grid h-full min-h-0 transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none ${contextPaneOpen
          ? 'grid-cols-[minmax(0,1fr)_22rem]'
          : 'grid-cols-[minmax(0,1fr)_0rem]'} max-[1279px]:grid-cols-1`}
        data-chat-workspace
      >
        <main aria-label={t('conversation')} className="grid min-h-0 min-w-0 grid-rows-[3rem_minmax(0,1fr)] overflow-hidden bg-background">
          <header className="window-no-drag flex min-w-0 items-center gap-1 border-b border-border px-3" data-chat-header>
            <Button
              aria-label={historyPaneOpen ? t('closeHistory') : t('openHistory')}
              className={`size-8 min-w-8 shrink-0 p-0 ${historyPaneOpen ? 'bg-surface-hover' : ''}`}
              data-chat-history-toggle
              isIconOnly
              onPress={() => {
                setCompactContextOpen(false)
                setHistoryPaneOpen((open) => !open)
              }}
              size="sm"
              variant="ghost"
            >
              <History aria-hidden="true" size={16} />
            </Button>
            <div className="flex min-w-0 items-baseline gap-2 px-1" data-chat-current-title>
              <strong className="min-w-0 truncate text-sm font-semibold text-foreground">{currentTitle}</strong>
              <span className="shrink-0 text-xs font-normal text-muted">{currentSubtitle}</span>
            </div>
            {thread?.kind === 'native-chat' && (
              <Button
                aria-label={t('chatManagement')}
                className="size-8 min-w-8 shrink-0 p-0"
                data-chat-management-trigger
                isIconOnly
                onPress={() => setManagementOpen(true)}
                size="sm"
                variant="ghost"
              >
                <MoreHorizontal aria-hidden="true" size={16} />
              </Button>
            )}
            <div className="ml-auto flex min-w-0 items-center gap-1">
              {thread?.kind === 'rules-generation'
                && thread.status === 'completed' && thread.candidateCount > 0 && (
                <Button className="gap-1 bg-primary text-primary-foreground" onPress={() => onOpenGeneratedRules(thread.runId)} size="sm">
                  {t('openGeneratedRules')}<ChevronRight aria-hidden="true" size={15} />
                </Button>
              )}
              {thread?.kind === 'native-chat'
                && thread.origin === 'rules'
                && thread.rulesArtifact
                && thread.rulesArtifact.candidateCount > 0 && (
                <Button className="gap-1 bg-primary text-primary-foreground" onPress={() => onOpenGeneratedRules(thread.rulesArtifact!.runId)} size="sm">
                  {t('openGeneratedRules')}<ChevronRight aria-hidden="true" size={15} />
                </Button>
              )}
              {thread?.kind === 'rules-generation' && canRegenerate(thread.status) && (
                <Button className="gap-1 bg-primary text-primary-foreground" isDisabled={isRegenerating} onPress={() => void regenerate()} size="sm">
                  {isRegenerating ? <Spinner color="current" size="sm" /> : <RotateCcw aria-hidden="true" size={15} />}
                  {isRegenerating ? t('regenerating') : t('regenerate')}
                </Button>
              )}
              {thread?.kind === 'rules-generation'
                && (thread.status === 'running' || thread.status === 'cancelling') && (
                <Button className="gap-1" isDisabled={thread.status === 'cancelling'} onPress={() => void stopGeneration()} size="sm" variant="ghost">
                  {thread.status === 'cancelling' ? <Spinner color="current" size="sm" /> : <Square aria-hidden="true" size={13} />}
                  {thread.status === 'cancelling' ? t('cancelling') : t('stopGeneration')}
                </Button>
              )}
              {!contextPanelOpen && (
                <Button
                  className="h-8 gap-1.5 border border-border bg-surface px-2.5 text-xs text-muted"
                  data-chat-context-reopen
                  onPress={() => setContextOpen(true)}
                  size="sm"
                  variant="ghost"
                >
                  <PanelRight aria-hidden="true" size={14} />
                  {t('contextShort')}
                  <span className="grid min-w-4 place-items-center rounded-full bg-primary-soft px-1 text-[9px] font-semibold text-success">{selectedContext.length}</span>
                </Button>
              )}
            </div>
          </header>

          {error && (
            <Alert className="absolute left-1/2 top-14 z-30 w-[min(42rem,calc(100%-7rem))] -translate-x-1/2 shadow-xl" status="danger">
              <Alert.Content><Alert.Title>{t(errorTitle)}</Alert.Title><Alert.Description>{error}</Alert.Description></Alert.Content>
            </Alert>
          )}

          <div
            className={`grid min-h-0 min-w-0 overflow-hidden transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none ${historyPaneOpen ? 'grid-cols-[18rem_minmax(0,1fr)]' : 'grid-cols-[0rem_minmax(0,1fr)]'} max-[1279px]:grid-cols-1`}
            data-chat-body
          >
            {historyPane}
            <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
            <section
              className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain px-5 pb-8 pt-8"
              data-chat-conversation
              onScroll={updateFollowState}
              ref={conversationRef}
            >
              {!thread && !legacy && !isSending ? (
                <div className="grid h-full place-items-center text-sm text-muted">{loading ? t('loading') : t('emptySelection')}</div>
              ) : thread?.kind === 'native-chat' ? (
                <NativeConversation liveStartedAt={liveStartedAt} liveTimeline={liveTimeline} thread={thread} />
              ) : !thread && isSending ? (
                <LiveTurn startedAt={liveStartedAt ?? undefined} timeline={liveTimeline} />
              ) : thread ? (
                <PersistedConversation thread={thread} />
              ) : (
                <LegacyConversation entry={legacy!} />
              )}
            </section>

            {!legacy && (!thread || (thread.kind === 'native-chat' && !thread.archivedAt)) && (
              <div className="bg-gradient-to-t from-background via-background to-transparent px-5 pb-4 pt-3" data-chat-composer>
                {pendingInteraction && (
                  <div className="mx-auto mb-3 grid w-full max-w-[51.25rem] gap-3 rounded-2xl border border-primary/40 bg-surface p-4 shadow-lg" data-chat-interaction-card>
                    <strong className="text-sm text-foreground">{pendingInteraction.request.title ?? t('interactionTitle')}</strong>
                    {pendingInteraction.request.questions.map((question) => (
                      <label className="grid gap-2 text-xs text-muted" key={question.id}>
                        <span>{question.label}</span>
                        {question.options?.length ? (
                          <div className="flex flex-wrap gap-2">
                            {question.options.map((option) => {
                              const selected = interactionAnswers[question.id]?.includes(option) === true
                              return <Button key={option} onPress={() => setInteractionAnswers((current) => ({
                                ...current,
                                [question.id]: question.multiple
                                  ? selected
                                    ? (current[question.id] ?? []).filter((item) => item !== option)
                                    : [...(current[question.id] ?? []), option]
                                  : [option],
                              }))} size="sm" variant={selected ? 'primary' : 'ghost'}>{option}</Button>
                            })}
                          </div>
                        ) : (
                          <input className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground" onChange={(event) => setInteractionAnswers((current) => ({ ...current, [question.id]: [event.target.value] }))} placeholder={question.placeholder} value={interactionAnswers[question.id]?.[0] ?? ''} />
                        )}
                      </label>
                    ))}
                    <div className="flex justify-end gap-2"><Button onPress={() => void respondToInteraction(true)} size="sm" variant="ghost">{t('cancel')}</Button><Button onPress={() => void respondToInteraction()} size="sm">{t('submitAnswer')}</Button></div>
                  </div>
                )}
                <div className="mx-auto w-full max-w-[51.25rem] overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_12px_32px_rgba(0,0,0,0.16)] transition-[border-color,box-shadow] duration-200 focus-within:border-primary/60 focus-within:shadow-[0_14px_36px_rgba(0,0,0,0.22)] motion-reduce:transition-none" data-chat-composer-surface>
                  {pastedTextAttachments.length > 0 && (
                    <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto px-3 pt-3" data-composer-pasted-text-attachments>
                      {pastedTextAttachments.map((attachment) => (
                        <div className="flex min-w-0 max-w-full items-center gap-2 rounded-xl bg-background/70 px-2.5 py-2 text-left" key={attachment.id}>
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-success">
                            <FileText aria-hidden="true" size={15} />
                          </span>
                          <span className="min-w-0">
                            <strong className="block truncate text-xs font-medium text-foreground">{t('pastedTextAttachment')}</strong>
                            <span className="block text-[10px] tabular-nums text-muted">{t('pastedTextCharacterCount', { count: formatNumber(attachment.characterCount, currentLocale()) })}</span>
                          </span>
                          {attachment.characterCount <= PASTED_TEXT_RESTORE_LIMIT && (
                            <Button aria-label={t('restorePastedText')} className="h-7 min-h-7 w-7 min-w-7" isIconOnly onPress={() => restorePastedTextAttachment(attachment.id)} size="sm" variant="ghost">
                              <RotateCcw aria-hidden="true" size={13} />
                            </Button>
                          )}
                          <Button aria-label={t('removePastedText')} className="h-7 min-h-7 w-7 min-w-7" isIconOnly onPress={() => removePastedTextAttachment(attachment.id)} size="sm" variant="ghost">
                            <X aria-hidden="true" size={13} />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  <textarea
                    aria-label={t('message')}
                    className="block max-h-44 min-h-16 w-full resize-none bg-transparent px-4 pb-1 pt-4 text-sm leading-6 text-foreground outline-none [scrollbar-gutter:stable] placeholder:text-muted"
                    onChange={(event) => {
                      const trigger = consumeSkillPickerTrigger(event.target.value)
                      setComposer(trigger.composer)
                      if (trigger.triggered) {
                        setComposerOptionsOpen(true)
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        sendChatMessage()
                      }
                    }}
                    onPaste={handleComposerPaste}
                    placeholder={t('messagePlaceholder')}
                    value={composer}
                  />
                  {selectedSkills.length > 0 && (
                    <div className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto px-3 pb-1" data-composer-skills>
                      {selectedSkills.map((name) => (
                        <button
                          aria-label={t('removeSkill', { name })}
                          className="flex items-center gap-1 rounded-full bg-primary-soft px-2 py-1 text-xs text-foreground transition-colors hover:bg-surface-hover"
                          key={name}
                          onClick={() => setSelectedSkills((current) => current.filter((item) => item !== name))}
                          type="button"
                        >
                          /{name}<X aria-hidden="true" size={12} />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="grid min-h-11 min-w-0 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden px-2 pb-2 pt-1 text-xs text-muted">
                    <div className="relative h-8" data-composer-options ref={composerOptionsRef}>
                      <Button aria-label={t('openSkillPicker')} className={`h-8 min-h-8 min-w-8 ${selectedSkills.length > 0 ? 'gap-1 px-2' : 'w-8'}`} isIconOnly={selectedSkills.length === 0} onPress={() => setComposerOptionsOpen((open) => !open)} size="sm" variant="ghost">
                        <Plus aria-label={t('moreOptions')} size={16} />
                        {selectedSkills.length > 0 && <span className="text-[11px] font-semibold text-success">{selectedSkills.length}</span>}
                      </Button>
                      {composerOptionsOpen && (
                        <ChatSkillPicker
                          onClose={() => setComposerOptionsOpen(false)}
                          onToggle={(name) => setSelectedSkills((current) => current.includes(name)
                            ? current.filter((item) => item !== name)
                            : [...current, name])}
                          recentNames={recentSkills}
                          selectedNames={selectedSkills}
                          skills={skills}
                        />
                      )}
                    </div>
                    <Button className="h-8 min-h-8 gap-1 border-0 bg-transparent px-2 shadow-none hover:bg-background/60" data-composer-context onPress={() => setContextOpen(true)} size="sm" variant="ghost">
                      <PanelRight aria-hidden="true" size={14} />{t('contextShort')} <span className="font-semibold text-success">{selectedContext.length}</span>
                    </Button>
                    <div className="flex h-8 min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-composer-runtime>
                      <Select aria-label={t('agent')} className="w-24 shrink-0" isDisabled={thread?.kind === 'native-chat'} onSelectionChange={(key) => changeProvider(String(key) as ProviderId)} selectedKey={thread?.kind === 'native-chat' ? thread.provider : provider}>
                        <Select.Trigger className="h-8 min-h-8 border-0 bg-transparent px-2.5 text-xs shadow-none hover:bg-background/60"><Select.Value /><Select.Indicator /></Select.Trigger>
                        <Select.Popover><ListBox>{providerSnapshot.entries.filter((entry) => entry.enabled).map((entry) => <ListBox.Item id={entry.id} key={entry.id}>{entry.label}</ListBox.Item>)}</ListBox></Select.Popover>
                      </Select>
                      <Select aria-label={t('model')} className="w-36 shrink-0" onSelectionChange={(key) => { const next = String(key) === '__default' ? '' : String(key); setModel(next); const selected = providerSnapshot.entries.find((entry) => entry.id === provider)?.models.find((entry) => entry.id === next); setThinkingOptionId(selected?.defaultThinkingOptionId ?? '') }} selectedKey={model || '__default'}>
                        <Select.Trigger className="h-8 min-h-8 border-0 bg-transparent px-2.5 text-xs shadow-none hover:bg-background/60"><Select.Value /><Select.Indicator /></Select.Trigger>
                        <Select.Popover><ListBox><ListBox.Item id="__default">{t('providerDefaultModel')}</ListBox.Item>{(providerSnapshot.entries.find((entry) => entry.id === provider)?.models ?? []).map((entry) => <ListBox.Item id={entry.id} key={entry.id}>{entry.label}</ListBox.Item>)}</ListBox></Select.Popover>
                      </Select>
                      {(provider === 'claude' || provider === 'codex') && <Select aria-label={t('effort')} className="w-24 shrink-0" onSelectionChange={(key) => setEffort(String(key) as typeof effort)} selectedKey={effort}>
                        <Select.Trigger className="h-8 min-h-8 border-0 bg-transparent px-2.5 text-xs shadow-none hover:bg-background/60"><Select.Value /><Select.Indicator /></Select.Trigger>
                        <Select.Popover><ListBox>{CHAT_EFFORTS.map((value) => <ListBox.Item id={value} key={value}>{value}</ListBox.Item>)}</ListBox></Select.Popover>
                      </Select>}
                      {(providerSnapshot.entries.find((entry) => entry.id === provider)?.models.find((entry) => entry.id === model)?.thinkingOptions?.length ?? 0) > 0 && <Select aria-label={t('thinking')} className="w-24 shrink-0" onSelectionChange={(key) => setThinkingOptionId(String(key))} selectedKey={thinkingOptionId}>
                        <Select.Trigger className="h-8 min-h-8 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-background/60"><Select.Value /><Select.Indicator /></Select.Trigger>
                        <Select.Popover><ListBox>{providerSnapshot.entries.find((entry) => entry.id === provider)?.models.find((entry) => entry.id === model)?.thinkingOptions?.map((option) => <ListBox.Item id={option.id} key={option.id}>{option.label}</ListBox.Item>)}</ListBox></Select.Popover>
                      </Select>}
                      {providerSnapshot.entries.find((entry) => entry.id === provider)?.capabilities.supportsFastMode && <label className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border-0 bg-transparent px-2.5 text-[11px] text-foreground shadow-none transition-colors hover:bg-background/60" data-composer-fast-mode>
                        <Zap aria-hidden="true" className={fastMode ? 'text-success' : 'text-muted'} size={13} />
                        <span>{t('fast')}</span>
                        <Switch aria-label={t('fastMode')} isSelected={fastMode} onChange={setFastMode} size="sm">
                          <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
                        </Switch>
                      </label>}
                    </div>
                    <div className="relative z-10 flex h-8 shrink-0 items-center gap-2.5 border-l border-border bg-surface pl-3 pr-0.5" data-composer-actions>
                      <span className="flex items-center gap-1 whitespace-nowrap text-[11px]"><ShieldCheck className="text-success" size={14} />{t('fullAccess')}</span>
                      <Tooltip delay={0}>
                        <Tooltip.Trigger
                          aria-label={contextUsageLabel}
                          className="grid size-6 shrink-0 place-items-center rounded-full"
                          data-context-usage-trigger
                        >
                          <span
                            aria-hidden="true"
                            className="size-4 rounded-full border-2 border-border"
                            style={contextUsage ? { background: `conic-gradient(var(--color-success) ${contextPercent}%, transparent 0)` } : undefined}
                          />
                        </Tooltip.Trigger>
                        <Tooltip.Content>
                          {contextUsageLabel}
                        </Tooltip.Content>
                      </Tooltip>
                      {showStopChatTurn && (
                        <Button className="h-8 min-h-8 w-8 min-w-8" isIconOnly onPress={() => void stopChatTurn()} size="sm" variant="ghost"><Square aria-label={t('stopChat')} size={14} /></Button>
                      )}
                      <Button aria-label={isSending ? t('queue', { count: queuedCount }) : t('send')} className="h-8 min-h-8 w-8 min-w-8 rounded-full bg-primary text-primary-foreground" isDisabled={!composer.trim() && pastedTextAttachments.length === 0} isIconOnly onPress={sendChatMessage} size="sm">
                        <Send aria-hidden="true" size={15} />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            </div>
          </div>
        </main>

        <aside
          aria-hidden={!contextPanelOpen}
          aria-label={t('context')}
          className={`grid min-h-0 grid-rows-[3rem_minmax(0,1fr)] overflow-hidden border-l border-border bg-surface transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none max-[1279px]:fixed max-[1279px]:bottom-4 max-[1279px]:right-4 max-[1279px]:top-12 max-[1279px]:z-40 max-[1279px]:w-[22rem] max-[1279px]:rounded-2xl max-[1279px]:border max-[1279px]:shadow-2xl ${contextVisibilityClass}`}
          data-chat-context-panel
          inert={!contextPanelOpen}
        >
          <header className="flex items-center gap-2 border-b border-border pl-4 pr-2">
            <strong className="text-sm font-semibold text-foreground">{t('sessionContext')}</strong>
            <Chip size="sm" variant="soft">{selectedContext.length}</Chip>
            <Button
              className="ml-auto h-8 gap-1.5 px-2 text-xs text-muted"
              data-chat-context-close
              onPress={() => setContextOpen(false)}
              size="sm"
              variant="ghost"
            >
              <PanelRight aria-hidden="true" size={14} />{t('collapse')}
            </Button>
          </header>
          <div className="min-h-0 overflow-hidden">
            {!legacy && (!thread || (thread.kind === 'native-chat' && !thread.archivedAt)) && (
              <SessionContextPicker
                cursor={contextCursor}
                from={contextFrom}
                items={contextItems}
                loading={contextLoading}
                onLoadMore={() => void loadContextSessions(true)}
                onProjectChange={setContextProject}
                onRangeChange={(nextFrom, nextTo) => { setContextFrom(nextFrom); setContextTo(nextTo) }}
                onRecentDays={selectRecentContextDays}
                onSelectedChange={(next) => void updateSelectedContext(next)}
                project={contextProject}
                projects={projects}
                selected={selectedContext}
                selectedItems={selectedContextItems}
                to={contextTo}
              />
            )}
          </div>
        </aside>
      </div>

      <button
        aria-hidden={!overlayOpen}
        aria-label={t('closePanels')}
        className={`absolute inset-0 top-12 z-30 cursor-default bg-black/45 transition-opacity duration-200 motion-reduce:transition-none ${overlayOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onClick={() => { setHistoryPaneOpen(false); setCompactContextOpen(false) }}
        tabIndex={overlayOpen ? 0 : -1}
        type="button"
      />
      {historyContextMenu && historyContextThread && (
        <div
          aria-label={t('historyActions')}
          className="fixed z-[70] grid w-44 gap-1 rounded-xl border border-border bg-surface p-1.5 text-xs shadow-2xl"
          data-chat-history-context-menu
          onMouseLeave={() => setHistoryContextMenu(null)}
          role="menu"
          style={{ left: historyContextMenu.x, top: historyContextMenu.y }}
        >
          <Button className="h-8 justify-start gap-2 px-2" onPress={() => void openHistoryManagement(historyContextMenu.item)} size="sm" variant="ghost"><Pencil size={14} />{t('renameChat')}</Button>
          <Button className="h-8 justify-start gap-2 px-2" onPress={() => void setHistoryPinned(historyContextMenu.item, !historyContextThread.pinnedAt)} size="sm" variant="ghost">
            {historyContextThread.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />}
            {historyContextThread.pinnedAt ? t('unpinChat') : t('pinChat')}
          </Button>
          <Button className="h-8 justify-start gap-2 px-2" isDisabled={lifecycleBusy} onPress={() => void setHistoryArchived(historyContextMenu.item, !historyContextThread.archivedAt)} size="sm" variant="ghost">
            {historyContextThread.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {historyContextThread.archivedAt ? t('restoreChat') : t('archiveChat')}
          </Button>
        </div>
      )}
      <Modal
        isOpen={managementOpen && thread?.kind === 'native-chat'}
        onOpenChange={setManagementOpen}
      >
        <Modal.Backdrop>
          <Modal.Container placement="center" size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{t('chatManagement')}</Modal.Heading>
                <Modal.CloseTrigger />
              </Modal.Header>
              {thread?.kind === 'native-chat' && (
                <Modal.Body>
                  <div className="grid gap-3">
                    <div className="flex gap-2">
                      <input
                        aria-label={t('chatTitle')}
                        className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
                        onChange={(event) => setRenameValue(event.target.value)}
                        value={renameValue}
                      />
                      <Button
                        className="gap-2"
                        isDisabled={lifecycleBusy || !renameValue.trim()}
                        onPress={() => void renameCurrentChat()}
                        size="sm"
                        variant="ghost"
                      >
                        <Pencil aria-hidden="true" size={14} />
                        {t('renameChat')}
                      </Button>
                    </div>
                    {thread.archivedAt ? (
                      <div className="flex gap-2">
                        <Button
                          className="flex-1 gap-2"
                          isDisabled={lifecycleBusy}
                          onPress={() => {
                            setManagementOpen(false)
                            void restoreCurrentChat()
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          <ArchiveRestore size={14} />{t('restoreChat')}
                        </Button>
                        <Button
                          className="gap-2 text-danger"
                          isDisabled={lifecycleBusy}
                          onPress={() => {
                            setManagementOpen(false)
                            setDeleteConfirmThread(thread)
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          <Trash2 size={14} />{t('deleteForever')}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        className="gap-2"
                        isDisabled={lifecycleBusy}
                        onPress={() => {
                          setManagementOpen(false)
                          void archiveCurrentChat()
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        <Archive size={14} />{t('archiveChat')}
                      </Button>
                    )}
                    {thread.nativeState === 'resume-failed' && (
                      <div className="grid gap-2 rounded-lg border border-danger/40 p-3">
                        <span className="text-xs text-danger">{t('resumeFailed')}</span>
                        <Button
                          onPress={() => {
                            setManagementOpen(false)
                            continueAsNewChat()
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          {t('continueAsNew')}
                        </Button>
                      </div>
                    )}
                  </div>
                </Modal.Body>
              )}
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
      <Modal isOpen={Boolean(deleteConfirmThread)} onOpenChange={(open) => !open && setDeleteConfirmThread(null)}>
        <Modal.Backdrop>
          <Modal.Container placement="center" size="md">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{t('deleteChatTitle')}</Modal.Heading>
                <Modal.CloseTrigger />
              </Modal.Header>
              <Modal.Body>
                <p className="text-sm leading-6 text-muted">{t('deleteChatDescription', { title: deleteConfirmThread?.title ?? '' })}</p>
              </Modal.Body>
              <Modal.Footer>
                <Button isDisabled={lifecycleBusy} onPress={() => setDeleteConfirmThread(null)} variant="ghost">{t('cancel')}</Button>
                <Button className="bg-danger text-white" isDisabled={lifecycleBusy} onPress={() => void permanentlyDeleteChat()}>
                  {lifecycleBusy ? <Spinner color="current" size="sm" /> : <Trash2 size={14} />}
                  {t('deleteForever')}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </section>
  )
}

function NativeConversation({
  thread,
  liveStartedAt,
  liveTimeline,
}: {
  thread: Extract<ChatThread, { version: 2 }>
  liveStartedAt: string | null
  liveTimeline: NativeTurnTimelineItem[]
}) {
  const { t } = useTranslation('chat')
  return (
    <div className="mx-auto grid min-h-full w-full max-w-[51.25rem] content-end gap-7 py-4">
      {thread.messages.map((message, index) => message.role === 'user' ? (
        <div className="grid justify-items-end gap-1" key={message.id}>
          <div className="max-w-[68%] rounded-2xl rounded-tr-md bg-surface-hover px-4 py-3 text-sm leading-6 text-foreground">
            {message.attachments && message.attachments.length > 0 && (
              <div className="grid gap-1.5" data-chat-message-attachments>
                {message.attachments.map((attachment, attachmentIndex) => (
                  <div className="flex items-center gap-2 rounded-xl bg-background/55 px-2.5 py-2" key={`${attachment.name}-${attachmentIndex}`}>
                    <FileText aria-hidden="true" className="shrink-0 text-success" size={15} />
                    <span className="min-w-0">
                      <strong className="block truncate text-xs font-medium">{attachment.name}</strong>
                      <span className="block text-[10px] tabular-nums text-muted">{t('pastedTextCharacterCount', { count: formatNumber(attachment.characterCount, currentLocale()) })}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {message.content && <p className={`${message.attachments?.length ? 'mt-2' : ''} break-words whitespace-pre-wrap`}>{message.content}</p>}
          </div>
          {message.turnConfig && <TurnConfigLine config={message.turnConfig} />}
        </div>
      ) : (
        <article className="grid min-w-0 max-w-full gap-3 overflow-hidden text-sm leading-7 text-foreground" key={message.id}>
          {message.timeline && message.timeline.length > 0 ? (
            <NativeTurnTimeline chatId={thread.id} final timeline={message.timeline} />
          ) : (
            <>
              <ToolActivityList activities={message.toolActivities ?? []} chatId={thread.id} />
              {message.content && <MarkdownMessage content={message.content} final />}
            </>
          )}
          <MessageFooter message={message} startedAt={assistantTurnStartedAt(thread.messages, index)} />
        </article>
      ))}
      {thread.status === 'running' && (
        <LiveTurn
          chatId={thread.id}
          startedAt={assistantTurnStartedAt(thread.messages, thread.messages.length) ?? liveStartedAt ?? undefined}
          timeline={liveTimeline}
        />
      )}
      {thread.lastError && <Alert status="danger"><Alert.Description>{thread.lastError}</Alert.Description></Alert>}
    </div>
  )
}

function LiveTurn({
  timeline,
  chatId,
  startedAt,
}: {
  timeline: NativeTurnTimelineItem[]
  chatId?: string
  startedAt?: string
}) {
  return (
    <article className="mx-auto grid min-h-full w-full max-w-[51.25rem] content-end gap-3 py-4 text-sm leading-7 text-foreground">
      <NativeTurnTimeline chatId={chatId} final={false} timeline={timeline} />
      {startedAt
        ? <RunningElapsed showLabel startedAt={startedAt} />
        : <Spinner color="accent" size="sm" />}
    </article>
  )
}

function NativeTurnTimeline({ timeline, chatId, final }: {
  timeline: NativeTurnTimelineItem[]
  chatId?: string
  final: boolean
}) {
  if (timeline.length === 0) return null
  const groupedTimeline = groupNativeTurnTimeline(timeline)
  return (
    <div className="grid min-w-0 max-w-full gap-3" data-native-turn-timeline>
      {groupedTimeline.map((item) => {
        if (item.type === 'assistant') {
          return item.content
            ? <MarkdownMessage content={item.content} final={final} key={`assistant-${item.itemId}`} />
            : null
        }
        if (item.type === 'thinking') {
          return <NativeThinkingRow item={item} key={`thinking-${item.itemId}`} />
        }
        if (item.type === 'tool-group') {
          return <ToolActivityList activities={item.activities} chatId={chatId} key={`tool-group-${item.itemId}`} />
        }
        return <NativeToolCard activity={item.activity} chatId={chatId} key={`tool-${item.itemId}`} />
      })}
    </div>
  )
}

function NativeThinkingRow({ item }: {
  item: Extract<NativeTurnTimelineItem, { type: 'thinking' }>
}) {
  const { t } = useTranslation('chat')
  const content = normalizeThinkingMarkdown(item.content)
  if (!content.trim()) return null
  return (
    <div className="min-w-0 text-sm text-muted">
      <div className="grid min-h-8 w-full grid-cols-[1.1rem_auto_minmax(0,1fr)_auto] items-center gap-2 px-1">
        <Brain aria-hidden="true" size={15} />
        <strong className="text-xs font-medium text-foreground">{t('thinking')}</strong>
        <span />
        {item.status === 'running' && <Spinner color="accent" size="sm" />}
      </div>
      <div className="ml-[1.6rem] mt-1 min-w-0 border-l border-border py-1 pl-3">
        <MarkdownMessage
          content={content}
          final={item.status !== 'running'}
          variant="thinking"
        />
      </div>
    </div>
  )
}

function ToolActivityList({ activities, chatId }: {
  activities: NativeToolActivity[]
  chatId?: string
}) {
  if (activities.length === 0) return null
  if (activities.length === 1) {
    return <NativeToolCard activity={activities[0]} chatId={chatId} />
  }
  return <NativeToolGroup activities={activities} chatId={chatId} />
}

function NativeToolGroup({ activities, chatId }: {
  activities: NativeToolActivity[]
  chatId?: string
}) {
  const { t } = useTranslation('chat')
  const failedCount = activities.filter((activity) => activity.status === 'failed').length
  const running = activities.some((activity) => activity.status === 'running')
  const [expanded, setExpanded] = useState(failedCount > 0)
  const revealedFailure = useRef(failedCount > 0)
  const counts = toolActivityCounts(activities)
  const summary = [
    counts.read > 0 ? t('toolGroupRead', { count: counts.read }) : null,
    counts.search > 0 ? t('toolGroupSearch', { count: counts.search }) : null,
    counts.shell > 0 ? t('toolGroupShell', { count: counts.shell }) : null,
    counts.tool > 0 ? t('toolGroupTool', { count: counts.tool }) : null,
  ].filter((part): part is string => Boolean(part))
    .join(currentLocale() === 'zh-CN' ? '，' : ', ')
  const kinds = new Set(activities.map((activity) => activity.kind))
  const GroupIcon = kinds.size === 1 ? activityIcon(activities[0].kind) : Wrench

  useEffect(() => {
    if (failedCount > 0 && !revealedFailure.current) {
      revealedFailure.current = true
      setExpanded(true)
    }
  }, [failedCount])

  return (
    <div className="min-w-0 max-w-full overflow-hidden" data-tool-activity-group>
      <button
        aria-expanded={expanded}
        className="grid min-h-8 w-full grid-cols-[1.1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-1 text-left text-muted transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:text-foreground"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <GroupIcon aria-hidden="true" size={15} />
        <strong className="min-w-0 truncate text-xs font-medium text-foreground">{summary}</strong>
        <span className="flex items-center gap-2">
          {failedCount > 0 && <span className="text-[11px] font-medium text-danger">{t('toolGroupFailed', { count: failedCount })}</span>}
          {running && <Spinner color="accent" size="sm" />}
          <ChevronRight aria-hidden="true" className={`transition-transform ${expanded ? 'rotate-90' : ''}`} size={14} />
        </span>
      </button>
      {expanded && (
        <div className="ml-[1.6rem] mt-1 grid min-w-0 gap-1 border-l border-border pl-3" role="list">
          {activities.map((activity) => (
            <NativeToolCard activity={activity} chatId={chatId} key={activity.itemId} />
          ))}
        </div>
      )}
    </div>
  )
}

function NativeToolCard({ activity, chatId }: {
  activity: NativeToolActivity
  chatId?: string
}) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const [content, setContent] = useState('')
  const [nextCursor, setNextCursor] = useState<number | null>(0)
  const [loading, setLoading] = useState(false)
  const [available, setAvailable] = useState(true)

  async function loadPage(cursor: number): Promise<void> {
    if (!chatId || loading) return
    setLoading(true)
    try {
      const page = await window.api.invoke<NativeToolItemPage>('chat.tool.read', {
        chatId, itemId: activity.itemId, cursor, limit: 8192,
      })
      setAvailable(page.available)
      setContent((current) => cursor === 0 ? page.content : `${current}${page.content}`)
      setNextCursor(page.nextCursor)
    } catch {
      setAvailable(false)
      setNextCursor(null)
    } finally {
      setLoading(false)
    }
  }

  function toggle(): void {
    const next = !expanded
    setExpanded(next)
    if (next && !content && nextCursor === 0) void loadPage(0)
  }

  const Icon = activityIcon(activity.kind)
  const failed = activity.status === 'failed'
  return (
    <div className="min-w-0 max-w-full overflow-hidden" role="listitem">
      <button
        aria-expanded={expanded}
        className={`grid min-h-8 w-full grid-cols-[1.1rem_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-1 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover ${failed ? 'text-danger' : 'text-muted'}`}
        onClick={toggle}
        type="button"
      >
        <Icon aria-hidden="true" size={15} />
        <strong className={`text-xs font-medium ${failed ? 'text-danger' : 'text-foreground'}`}>{activity.name}</strong>
        <span className="min-w-0 truncate text-xs">{activity.summary}</span>
        <span className="flex items-center gap-2">
          {failed && <span className="text-[11px] font-medium">{t('status.failed')}</span>}
          {activity.status === 'running'
            ? <Spinner color="accent" size="sm" />
            : <ChevronRight aria-hidden="true" className={`transition-transform ${expanded ? 'rotate-90' : ''}`} size={14} />}
        </span>
      </button>
      {expanded && (
        <div className="mb-2 ml-[1.6rem] border-l border-border py-2 pl-3">
          {loading && !content ? <Spinner color="accent" size="sm" /> : available ? (
            <pre className="max-h-80 max-w-full overflow-auto break-words whitespace-pre-wrap text-xs leading-5 text-muted">{content}</pre>
          ) : <p className="text-xs text-muted">{t('toolSourceUnavailable')}</p>}
          {nextCursor !== null && nextCursor > 0 && (
            <Button className="mt-2" isDisabled={loading} onPress={() => void loadPage(nextCursor)} size="sm" variant="ghost">{t('loadMore')}</Button>
          )}
        </div>
      )}
    </div>
  )
}

function MessageFooter({ message, startedAt = message.createdAt }: {
  message: ChatMessage
  startedAt?: string
}) {
  const { t } = useTranslation('chat')
  const completedAt = message.completedAt ? Date.parse(message.completedAt) : Number.NaN
  const elapsed = Number.isFinite(completedAt)
    ? formatElapsed(startedAt, completedAt)
    : null

  return (
    <footer className="flex items-center gap-2 text-[11px] text-muted">
      <Button
        aria-label={t('copyResponse')}
        isIconOnly
        onPress={() => void navigator.clipboard.writeText(message.content)}
        size="sm"
        variant="ghost"
      >
        <Copy aria-hidden="true" size={14} />
      </Button>
      {elapsed && <span>{t('workedFor', { elapsed })}</span>}
    </footer>
  )
}

function TurnConfigLine({ config }: {
  config: { model?: string; effort: string; fastMode: boolean }
}) {
  const { t } = useTranslation('chat')
  return (
    <span className="text-[11px] text-muted">
      {config.model ?? t('providerDefaultModel')} · {config.effort}
      {config.fastMode ? ` · ${t('fastMode')}` : ''}
    </span>
  )
}

function PersistedConversation({ thread }: { thread: GenerationChatThread }) {
  const { t } = useTranslation('chat')
  const userMessage = thread.messages.find((message) => message.role === 'user')
  const assistantMessage = [...thread.messages].reverse().find(
    (message) => message.role === 'assistant',
  )
  const projectResponses = visibleProjectResponses(
    thread.status,
    thread.projectResponses,
  )
  const assistantContent = thread.status === 'completed'
    ? assistantMessage?.content ?? terminalMessage(thread.status, t)
    : terminalMessage(thread.status, t)
  return (
    <div className="mx-auto grid min-h-full w-full max-w-[51.25rem] content-end gap-7 py-4">
      <div className="flex justify-end">
        <div className="max-w-[68%] rounded-2xl rounded-tr-md bg-surface-hover px-4 py-3 text-sm leading-6 text-foreground">
          {userMessage?.kind === 'rules-generation-request'
            ? requestMessage(thread.request, t)
            : userMessage?.content ?? scopeLabel(thread.request, t)}
        </div>
      </div>
      <article className="min-w-0">
        <div className="min-w-0">
          {assistantContent ? <MarkdownMessage content={assistantContent} final /> : null}
          <ActivityTimeline thread={thread} />
          <div className="mt-5 grid gap-3">
            {projectResponses.flatMap((response) =>
              response.candidates.map((candidate, index) => (
                <Card className="border border-border bg-surface shadow-none" key={`${response.projectSlug}-${index}`}>
                  <Card.Content className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <span className="text-xs text-muted">{response.projectSlug}</span>
                        <strong className="mt-1 block text-sm font-medium leading-6 text-foreground">
                          {candidate.rule}
                        </strong>
                      </div>
                      <Chip color={confidenceColor(candidate.confidence)} size="sm" variant="soft">
                        {candidate.confidence}
                      </Chip>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-muted">
                      <strong className="text-foreground">{t('candidateReasoning')}：</strong>
                      {candidate.reasoning}
                    </p>
                    {candidate.evidenceRefs.length > 0 && (
                      <p className="mt-2 break-words text-xs leading-5 text-muted">
                        <strong className="text-foreground">{t('candidateEvidence')}：</strong>
                        {candidate.evidenceRefs.join(' · ')}
                      </p>
                    )}
                  </Card.Content>
                </Card>
              )),
            )}
            {thread.status === 'completed' && projectResponses.every(
              (response) => response.candidates.length === 0,
            ) && (
              <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
                {t('noCandidates')}
              </p>
            )}
          </div>
          {assistantMessage && <div className="mt-4"><MessageFooter message={assistantMessage} /></div>}
        </div>
      </article>
    </div>
  )
}

interface MarkdownMessageProps {
  content: string
  final: boolean
  variant?: 'default' | 'thinking'
}

function MarkdownMessage({ content, final, variant = 'default' }: MarkdownMessageProps) {
  const isDark = document.documentElement.classList.contains('dark')
  return (
    <div className={variant === 'thinking'
      ? 'chat-markdown chat-markdown-thinking text-xs leading-5 text-muted'
      : 'chat-markdown text-sm leading-7 text-foreground'}>
      <MarkdownRender
        batchRendering={false}
        content={content}
        deferNodesUntilVisible={false}
        fade={false}
        final={final}
        isDark={isDark}
        renderCodeBlocksAsPre
      />
    </div>
  )
}

function ActivityTimeline({ thread }: { thread: GenerationChatThread }) {
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(
    () => new Set(),
  )
  const activities = mergeTimelineActivities(thread.activities)
  const active = thread.status === 'running' || thread.status === 'cancelling'
  if (activities.length === 0 && !active) return null

  return (
    <div className="mt-5">
      {activities.length > 0 && (
        <div className="grid gap-3" role="list">
          {activities.map((activity) => {
            const activityId = activity.id ?? `${activity.kind}-${activity.seq}`
            return (
              <ActivityRow
                activity={activity}
                expanded={expandedActivityIds.has(activityId)}
                key={activityId}
                onToggle={() => {
                  setExpandedActivityIds((current) => {
                    const next = new Set(current)
                    if (next.has(activityId)) next.delete(activityId)
                    else next.add(activityId)
                    return next
                  })
                }}
              />
            )
          })}
        </div>
      )}
      {active && <RunningElapsed startedAt={thread.createdAt} />}
    </div>
  )
}

function ActivityRow({
  activity,
  expanded,
  onToggle,
}: {
  activity: GenerationChatThread['activities'][number]
  expanded: boolean
  onToggle: () => void
}) {
  const Icon = activityIcon(activity.kind)
  const expandable = activity.kind === 'thinking' && Boolean(activity.detail)
  return (
    <div className="text-sm text-muted" role="listitem">
      <button
        aria-expanded={expandable ? expanded : undefined}
        className={`grid w-full grid-cols-[1.1rem_auto_minmax(0,1fr)_auto] items-center gap-2 text-left ${
          expandable ? 'cursor-pointer' : 'cursor-default'
        }`}
        disabled={!expandable}
        onClick={onToggle}
        type="button"
      >
        <Icon aria-hidden="true" className="text-muted" size={15} />
        <strong className="font-medium text-foreground">
          {activity.label ?? activityLabel(activity.kind)}
        </strong>
        {activity.detail && !expandable && (
          <span className="min-w-0 truncate" title={activity.detail}>
            {activity.detail}
          </span>
        )}
        {expandable && (
          <ChevronRight
            aria-hidden="true"
            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
            size={14}
          />
        )}
      </button>
      {expandable && expanded && (
        <p className="ml-[1.6rem] mt-2 whitespace-pre-wrap border-l border-border pl-3 text-xs leading-5 text-muted">
          {activity.detail}
        </p>
      )}
    </div>
  )
}

function RunningElapsed({ startedAt, showLabel = false }: { startedAt: string; showLabel?: boolean }) {
  const { t } = useTranslation('chat')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="mt-5 flex items-center gap-2 text-sm text-muted">
      <Spinner color="accent" size="sm" />
      <span>{showLabel ? t('workedFor', { elapsed: formatElapsed(startedAt, now) }) : formatElapsed(startedAt, now)}</span>
    </div>
  )
}

function activityIcon(kind: string): LucideIcon {
  if (kind === 'thinking') return Brain
  if (kind === 'read') return Eye
  if (kind === 'search') return Search
  if (kind === 'shell') return SquareTerminal
  if (kind === 'collect' || kind === 'evidence_ready') return Search
  if (kind === 'analyze' || kind === 'phase') return Brain
  if (kind === 'draft' || kind === 'project_response') return FilePenLine
  if (kind === 'validate' || kind === 'candidate_count') return CheckCircle2
  if (kind === 'retry') return RotateCcw
  return Wrench
}

function activityLabel(kind: string): string {
  if (kind === 'thinking') return 'Thinking'
  if (kind === 'read') return 'Read'
  if (kind === 'search') return 'Search'
  if (kind === 'shell') return 'Shell'
  if (kind === 'collect' || kind === 'evidence_ready') return 'Collect'
  if (kind === 'analyze' || kind === 'phase') return 'Analyze'
  if (kind === 'draft' || kind === 'project_response') return 'Draft'
  if (kind === 'validate' || kind === 'candidate_count') return 'Validate'
  if (kind === 'retry') return 'Retry'
  return kind.replace(/_/g, ' ')
}

function LegacyConversation({ entry }: { entry: GenerationHistoryEntry }) {
  const { t } = useTranslation('chat')
  return (
    <div className="mx-auto grid min-h-full w-full max-w-[51.25rem] content-end gap-7 py-4">
      <div className="flex justify-end">
        <div className="max-w-xl rounded-2xl rounded-tr-md bg-surface-hover px-4 py-3 text-sm text-foreground">
          {scopeLabel(entry.request, t)}
        </div>
      </div>
      <article className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
        <span className="grid size-8 place-items-center rounded-lg bg-surface-hover text-muted">
          <Clock3 aria-hidden="true" size={16} />
        </span>
        <div>
          <div className="flex items-center gap-2">
            <strong className="text-sm font-medium text-foreground">{t('assistant')}</strong>
            <Chip color="warning" size="sm" variant="soft">{t('legacy')}</Chip>
          </div>
          <p className="mt-3 text-sm leading-7 text-muted">{t('legacyDescription')}</p>
          <Card className="mt-4 border border-border bg-surface shadow-none">
            <Card.Content className="grid grid-cols-3 gap-4 p-4 max-sm:grid-cols-1">
              <ContextDetail label={t('projects')} value={String(entry.evidence?.projectCount ?? 0)} />
              <ContextDetail label={t('sessions')} value={String(entry.evidence?.totalSessions ?? 0)} />
              <ContextDetail label={t('candidates')} value={String(entry.candidateCount)} />
            </Card.Content>
          </Card>
        </div>
      </article>
    </div>
  )
}

function SessionContextPicker({
  cursor,
  from,
  items,
  loading,
  onLoadMore,
  onProjectChange,
  onRangeChange,
  onRecentDays,
  onSelectedChange,
  project,
  projects,
  selected,
  selectedItems,
  to,
}: {
  cursor: string | null
  from: string
  items: SessionContextItem[]
  loading: boolean
  onLoadMore: () => void
  onProjectChange: (value: string) => void
  onRangeChange: (from: string, to: string) => void
  onRecentDays: (days: number) => void
  onSelectedChange: (selected: NativeSessionReference[]) => void
  project: string
  projects: Project[]
  selected: NativeSessionReference[]
  selectedItems: SessionContextItem[]
  to: string
}) {
  const { t } = useTranslation('chat')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const listViewportRef = useRef<HTMLDivElement | null>(null)
  const rowHeight = 58
  const overscan = 4
  const { start, end } = virtualWindowRange({
    itemCount: items.length,
    overscan,
    rowHeight,
    scrollTop,
    viewportHeight,
  })
  const visibleItems = items.slice(start, end)
  const selectedKeys = new Set(selected.map(sessionReferenceKey))
  const allItemsSelected = items.length > 0
    && items.every((item) => selectedKeys.has(sessionReferenceKey(item)))
  const knownItems = new Map(selectedItems.map((item) => [sessionReferenceKey(item), item]))
  const projectOptions = ['default', ...projects.map((item) => item.slug)]
    .filter((value, index, values) => values.indexOf(value) === index)

  useEffect(() => {
    const viewport = listViewportRef.current
    if (!viewport) return
    const updateHeight = () => setViewportHeight(viewport.clientHeight)
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]" data-session-context>
      <div>
        <div className="flex h-44 flex-col border-b border-border p-4" data-session-context-selected>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted">{t('selectedSessions')}</span>
            <Button
              isDisabled={selected.length === 0}
              onPress={() => onSelectedChange([])}
              size="sm"
              variant="ghost"
            >
              {t('clearSelected')}
            </Button>
          </div>
          {selected.length > 0 ? (
            <div className="grid min-h-0 flex-1 gap-1 overflow-y-auto pr-1">
              {selected.map((reference) => {
                const item = knownItems.get(sessionReferenceKey(reference))
                return (
                  <button
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg bg-surface-hover px-2 py-1.5 text-left text-xs"
                    key={sessionReferenceKey(reference)}
                    onClick={() => onSelectedChange(selected.filter((current) => sessionReferenceKey(current) !== sessionReferenceKey(reference)))}
                    type="button"
                    title={`${reference.agent} · ${reference.id}`}
                  >
                    <span className="grid size-4 shrink-0 place-items-center rounded bg-success/15 text-[9px] font-bold text-success">{reference.agent.slice(0, 1).toUpperCase()}</span>
                    <span className="min-w-0 flex-1 truncate">{sessionDisplayName(item ?? reference)}</span>
                    {item && !item.sourceAvailable && <span className="text-danger">{t('sourceMissing')}</span>}
                    <span aria-label={t('removeSession')}>×</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 place-items-center text-center text-[11px] leading-5 text-muted">
              {t('noSelectedSessions')}
            </div>
          )}
        </div>
        <div className="border-b border-border p-4">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted">
            {t('sessionFilters')}
          </div>
          <Select aria-label={t('contextProject')} onSelectionChange={(key) => onProjectChange(String(key))} selectedKey={project}>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover><ListBox><ListBox.Item id="all">{t('allProjects')}</ListBox.Item>{projectOptions.map((slug) => <ListBox.Item id={slug} key={slug}>{slug === 'default' ? t('defaultProject') : slug}</ListBox.Item>)}</ListBox></Select.Popover>
          </Select>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input aria-label={t('contextFrom')} className="min-w-0 rounded-lg border border-border bg-surface px-2 py-2 text-xs text-foreground" onChange={(event) => onRangeChange(event.target.value, to)} type="date" value={from} />
            <input aria-label={t('contextTo')} className="min-w-0 rounded-lg border border-border bg-surface px-2 py-2 text-xs text-foreground" onChange={(event) => onRangeChange(from, event.target.value)} type="date" value={to} />
          </div>
          <div className="mt-2 flex gap-1">
            <Button onPress={() => onRecentDays(7)} size="sm" variant="ghost">{t('recent7Days')}</Button>
            <Button onPress={() => onRecentDays(30)} size="sm" variant="ghost">{t('recent30Days')}</Button>
            {(from || to) && <Button onPress={() => onRangeChange('', '')} size="sm" variant="ghost">{t('clearRange')}</Button>}
          </div>
        </div>
      </div>
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] p-4" data-session-context-list>
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
          <span>{t('availableSessions')}</span>
          <div className="flex items-center gap-1">
            <span>{items.length}</span>
            <Button
              className="h-6 min-h-6 px-2 text-[10px]"
              data-session-context-select-all
              isDisabled={items.length === 0}
              onPress={() => onSelectedChange(toggleAvailableSessionSelection(selected, items))}
              size="sm"
              variant="ghost"
            >
              {allItemsSelected ? t('deselectAll') : t('selectAll')}
            </Button>
          </div>
        </div>
        <div
          className="relative min-h-0 overflow-y-auto rounded-lg border border-border"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          ref={listViewportRef}
        >
          <div style={{ height: items.length * rowHeight }}>
            <div style={{ transform: `translateY(${start * rowHeight}px)` }}>
              {visibleItems.map((item) => {
                const active = selectedKeys.has(sessionReferenceKey(item))
                return (
                  <button
                    aria-pressed={active}
                    className={`flex h-[58px] w-full items-center gap-2 border-b border-border px-2 text-left text-xs ${
                      active ? 'bg-primary-soft' : 'hover:bg-surface-hover'
                    }`}
                    key={sessionReferenceKey(item)}
                    onClick={() => onSelectedChange(active
                      ? selected.filter((reference) => sessionReferenceKey(reference) !== sessionReferenceKey(item))
                      : [...selected, { agent: item.agent, id: item.id }])}
                    title={`${item.agent} · ${item.id}`}
                    type="button"
                  >
                    {active ? <CheckCircle2 className="shrink-0 text-primary" size={14} /> : <span className="size-3.5 shrink-0 rounded-full border border-border" />}
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate font-medium text-foreground">{sessionDisplayName(item)}</strong>
                      <span className="block truncate text-muted">{item.agent} · {item.slug} · {formatDateTime(item.updatedAt, currentLocale())}</span>
                    </span>
                    {!item.sourceAvailable && <span className="text-danger">{t('sourceMissing')}</span>}
                  </button>
                )
              })}
            </div>
          </div>
          {loading && <div className="absolute inset-0 grid place-items-center bg-surface/70"><Spinner color="accent" /></div>}
          {!loading && items.length === 0 && <div className="absolute inset-0 grid place-items-center px-3 text-center text-xs text-muted">{t('noContextSessions')}</div>}
        </div>
        {cursor && (
          <Button className="mt-2" fullWidth isDisabled={loading} onPress={onLoadMore} size="sm" variant="ghost">
            {t('loadMore')}
          </Button>
        )}
      </div>
    </section>
  )
}

function ContextDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="break-words text-sm text-foreground">{value}</span>
    </div>
  )
}

function canonicalSessionReferences(references: NativeSessionReference[]): NativeSessionReference[] {
  const unique = new Map(references.map((reference) => [sessionReferenceKey(reference), reference]))
  return [...unique.values()].sort((left, right) => sessionReferenceKey(left).localeCompare(sessionReferenceKey(right)))
}

function sessionReferenceKey(reference: NativeSessionReference): string {
  return `${reference.agent}\0${reference.id}`
}

function sessionDisplayName(
  session: NativeSessionReference & { displayName?: string; slug?: string },
): string {
  if (session.displayName?.trim()) return session.displayName.trim()
  if (session.slug?.trim() && session.slug !== 'unknown') return `${session.slug} · ${session.agent}`
  return `${session.agent} session`
}

function historyItemUpdatedAt(item: ChatHistoryItem): string {
  if (item.thread) return item.thread.updatedAt
  return item.legacy?.endedAt ?? item.legacy?.startedAt ?? ''
}

function formatContextUsage(
  usage: { usedTokens: number; maxTokens: number },
  percent: number,
): string {
  const locale = currentLocale()
  return `${formatNumber(usage.usedTokens, locale)} / ${formatNumber(usage.maxTokens, locale)} (${percent}%)`
}

function mergeSessionContextItems(
  current: SessionContextItem[],
  incoming: SessionContextItem[],
): SessionContextItem[] {
  const merged = new Map(current.map((item) => [sessionReferenceKey(item), item]))
  for (const item of incoming) merged.set(sessionReferenceKey(item), item)
  return [...merged.values()]
}

function localDateBoundary(value: string, endOfDay: boolean): string {
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`)
  if (!Number.isFinite(date.getTime())) throw new Error('invalid local date')
  return date.toISOString()
}

function localDateValue(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function scopeLabel(
  request: { mode: string; projects: string[] },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (request.mode === 'full') return t('scopeFull')
  if (request.mode === 'projects') {
    return t('scopeProjects', { count: request.projects.length })
  }
  return t('scopeRecent')
}

function legacyTitle(
  entry: GenerationHistoryEntry,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return `${t('legacy')} · ${scopeLabel(entry.request, t)}`
}

function threadTitle(
  request: { mode: string; projects: string[] },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (request.mode === 'full') return t('threadFull')
  if (request.mode === 'projects') {
    return t('threadProjects', { projects: request.projects.join(' · ') })
  }
  return t('threadRecent')
}

function requestMessage(
  request: { mode: string; projects: string[] },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (request.mode === 'full') return t('requestFull')
  if (request.mode === 'projects') {
    return t('requestProjects', { projects: request.projects.join('、') })
  }
  return t('requestRecent')
}

function terminalMessage(
  status: GenerationChatThread['status'],
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  if (status === 'completed') return t('generationCompleted')
  if (status === 'cancelled') return t('generationCancelled')
  if (status === 'failed') return t('generationFailed')
  if (status === 'interrupted') return t('generationInterrupted')
  return undefined
}

function confidenceColor(
  confidence: string,
): 'default' | 'success' | 'warning' {
  if (confidence === 'high') return 'success'
  if (confidence === 'medium') return 'warning'
  return 'default'
}

function isNativeChatEvent(value: unknown): value is NativeChatEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  if (event.type === 'assistant_delta' || event.type === 'thinking_delta') {
    return typeof event.itemId === 'string'
      && typeof event.text === 'string'
      && (event.content === undefined || typeof event.content === 'string')
  }
  if (event.type === 'usage') {
    if (!event.contextUsage || typeof event.contextUsage !== 'object') return false
    const usage = event.contextUsage as Record<string, unknown>
    return typeof usage.usedTokens === 'number' && typeof usage.maxTokens === 'number'
  }
  if (event.type === 'interaction_request') {
    return Boolean(event.request && typeof event.request === 'object')
  }
  if (event.type !== 'tool_activity' || !event.activity || typeof event.activity !== 'object') {
    return false
  }
  const activity = event.activity as Record<string, unknown>
  return typeof activity.itemId === 'string'
    && typeof activity.kind === 'string'
    && typeof activity.name === 'string'
    && typeof activity.status === 'string'
    && (activity.summary === undefined || typeof activity.summary === 'string')
}

const RECENT_SKILLS_STORAGE_KEY = 'memory-manager.chat.recent-skills'

function readRecentSkills(storage: Storage): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(RECENT_SKILLS_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string').slice(0, 6)
  } catch {
    return []
  }
}

function writeRecentSkills(storage: Storage, names: string[]): void {
  try {
    storage.setItem(RECENT_SKILLS_STORAGE_KEY, JSON.stringify(names))
  } catch {
    // UI 偏好写入失败不应阻止消息发送。
  }
}
