import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Chip, ListBox, Modal, Select, Spinner, Switch } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import {
  Brain,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Eye,
  FilePenLine,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RotateCcw,
  Search,
  Square,
  SquareTerminal,
  Trash2,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { currentLocale } from '../i18n'
import { formatDateTime } from '../i18n/format'
import type {
  ChatThread,
  ChatThreadSummary,
  GenerationChatThread,
  GenerationHistoryEntry,
  GenerationStartResult,
  NativeChatEvent,
  NativeToolActivity,
  NativeToolItemPage,
  ProviderId,
  ProviderSnapshot,
  Project,
  RunCancelResult,
  NativeSessionReference,
  SessionContextItem,
  SessionContextPage,
} from '../types'
import {
  canRegenerate,
  formatElapsed,
  mergeTimelineActivities,
  shouldFollowStream,
  visibleProjectResponses,
} from './chat-view-model'

interface QueuedChatTurn {
  message: string
  provider: ProviderId
  config: {
    model?: string
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    fastMode: boolean
  }
  sessionContext?: NativeSessionReference[]
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
  const [isSending, setIsSending] = useState(false)
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<(typeof CHAT_EFFORTS)[number]>('high')
  const [fastMode, setFastMode] = useState(false)
  const [providerSnapshot, setProviderSnapshot] = useState<ProviderSnapshot>({ entries: [], refreshing: false })
  const [skills, setSkills] = useState<Array<{ name: string }>>([])
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [liveAssistant, setLiveAssistant] = useState('')
  const [liveTools, setLiveTools] = useState<NativeToolActivity[]>([])
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
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [compactRailOpen, setCompactRailOpen] = useState(false)
  const [compactContextOpen, setCompactContextOpen] = useState(false)
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirmThread, setDeleteConfirmThread] = useState<Extract<ChatThread, { version: 2 }> | null>(null)
  const selectedIdRef = useRef<string | null>(selectedId)
  const liveChatIdRef = useRef<string | null>(null)
  const sendingRef = useRef(false)
  const queueRef = useRef<QueuedChatTurn[]>([])
  const preserveDraftContextRef = useRef(false)
  const conversationRef = useRef<HTMLElement | null>(null)
  const followStreamRef = useRef(true)

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  useEffect(() => {
    void Promise.all([
      window.api.invoke<ProviderSnapshot>('settings.providers.snapshot'),
      window.api.invoke<{
        provider: ProviderId
        model?: string
        effort: (typeof CHAT_EFFORTS)[number]
        fastMode?: boolean
      }>('settings.load'),
    ]).then(([snapshot, config]) => {
      setProviderSnapshot(snapshot)
      setProvider(config.provider)
      setModel(config.model ?? '')
      setEffort(config.effort)
      setFastMode(config.fastMode === true)
    }).catch(() => undefined)
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
    setSelectedContext(thread.sessionContext.selected)
    setRenameValue(thread.title)
  }, [thread?.id])

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
        ...reference, slug: 'unknown', updatedAt: '', status: 'missing', sourceAvailable: false,
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
    void window.api.invoke<Array<{ name: string }>>('chat.skills', provider)
      .then(setSkills)
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
      if (event.type === 'assistant_delta') {
        setLiveAssistant((current) => `${current}${event.text}`)
      } else if (event.type === 'tool_activity') {
        setLiveTools((current) => mergeNativeToolActivity(current, event.activity))
      } else {
        setLiveUsage(event.contextUsage)
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
      if (typeof chatId === 'string' && chatId === selectedIdRef.current) {
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
    setCompactRailOpen(false)
    setSelectedId(id)
    selectedIdRef.current = id
    void refresh(id)
  }

  function startDraft(): void {
    setCompactRailOpen(false)
    preserveDraftContextRef.current = false
    setSelectedId(null)
    selectedIdRef.current = null
    setThread(null)
    setLegacy(null)
    setComposer('')
    setLiveAssistant('')
    setLiveTools([])
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
    setSelectedContext(source.sessionContext.selected.map((reference) => ({ ...reference })))
    setComposer('')
    setError(null)
  }

  function sendChatMessage(): void {
    const message = composer.trim()
    if (!message) return
    if (thread && thread.kind !== 'native-chat') return
    const turn: QueuedChatTurn = {
      message,
      provider: thread?.provider ?? provider,
      config: { ...(model ? { model } : {}), effort, fastMode },
      ...(!thread ? { sessionContext: selectedContext.map((reference) => ({ ...reference })) } : {}),
    }
    setComposer('')
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
    setLiveAssistant('')
    setLiveTools([])
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
          },
        )
        currentChatId = result.chatId
        selectedIdRef.current = result.chatId
        setSelectedId(result.chatId)
        await refresh(result.chatId)
        setLiveAssistant('')
        setLiveTools([])
        next = queueRef.current.shift()
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

  return (
    <section aria-label={t('title')} className="grid h-[calc(100vh-4rem)] min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
      <div>
        <header className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
            <p className="mt-1 text-sm text-muted">{t('description')}</p>
          </div>
          <div className="ml-auto hidden gap-2 max-[1180px]:flex">
            <Button isIconOnly onPress={() => setCompactRailOpen(true)} size="sm" variant="ghost">
              <MessageSquareText aria-label={t('threadRail')} size={16} />
            </Button>
            <Button isIconOnly onPress={() => setCompactContextOpen(true)} size="sm" variant="ghost">
              <Eye aria-label={t('context')} size={16} />
            </Button>
          </div>
          {thread?.kind === 'rules-generation'
            && thread.status === 'completed' && thread.candidateCount > 0 && (
            <Button
              className="gap-2 bg-primary text-primary-foreground"
              onPress={() => onOpenGeneratedRules(thread.runId)}
            >
              {t('openGeneratedRules')}
              <ChevronRight aria-hidden="true" size={17} />
            </Button>
          )}
          {thread?.kind === 'native-chat'
            && thread.origin === 'rules'
            && thread.rulesArtifact
            && thread.rulesArtifact.candidateCount > 0 && (
            <Button
              className="gap-2 bg-primary text-primary-foreground"
              onPress={() => onOpenGeneratedRules(thread.rulesArtifact!.runId)}
            >
              {t('openGeneratedRules')}
              <ChevronRight aria-hidden="true" size={17} />
            </Button>
          )}
          {thread?.kind === 'rules-generation' && canRegenerate(thread.status) && (
            <Button
              className="gap-2 bg-primary text-primary-foreground"
              isDisabled={isRegenerating}
              onPress={() => void regenerate()}
            >
              {isRegenerating
                ? <Spinner color="current" size="sm" />
                : <RotateCcw aria-hidden="true" size={17} />}
              {isRegenerating ? t('regenerating') : t('regenerate')}
            </Button>
          )}
        </header>

        {error && (
          <Alert className="mb-4" status="danger">
            <Alert.Content>
              <Alert.Title>{t(errorTitle)}</Alert.Title>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </div>

      <Card className="min-h-0 overflow-hidden border border-border bg-surface shadow-none">
        <Card.Content className={`grid h-full min-h-0 ${railCollapsed
          ? 'grid-cols-[3.5rem_minmax(0,1fr)_17rem]'
          : 'grid-cols-[14rem_minmax(0,1fr)_17rem]'} p-0 max-[1180px]:grid-cols-1`}>
          {(compactRailOpen || compactContextOpen) && (
            <button
              aria-label={t('closePanels')}
              className="fixed inset-0 z-30 hidden cursor-default bg-black/40 max-[1180px]:block"
              onClick={() => { setCompactRailOpen(false); setCompactContextOpen(false) }}
              type="button"
            />
          )}
          <aside aria-label={t('threadRail')} className={`min-h-0 overflow-x-hidden overflow-y-auto border-r border-border bg-sidebar/40 max-[1180px]:fixed max-[1180px]:bottom-4 max-[1180px]:left-4 max-[1180px]:top-16 max-[1180px]:z-40 max-[1180px]:w-72 max-[1180px]:rounded-xl max-[1180px]:border max-[1180px]:shadow-xl ${compactRailOpen ? 'max-[1180px]:block' : 'max-[1180px]:hidden'}`}>
            <div className={`sticky top-0 z-10 border-b border-border bg-surface ${railCollapsed ? 'p-2' : 'px-4 py-3'}`}>
              <Button isIconOnly={railCollapsed} onPress={() => setRailCollapsed((value) => !value)} size="sm" variant="ghost">
                {railCollapsed ? <PanelLeftOpen aria-label={t('expandRail')} size={16} /> : <PanelLeftClose aria-label={t('collapseRail')} size={16} />}
              </Button>
              {!railCollapsed && (
                <>
                  <Button className="my-3 bg-primary text-primary-foreground" fullWidth onPress={startDraft}>
                    {t('newChat', { defaultValue: 'New Chat' })}
                  </Button>
                  <div className="flex gap-1">
                    <Button className="flex-1" onPress={() => setHistoryMode('active')} size="sm" variant={historyMode === 'active' ? 'primary' : 'ghost'}>{t('activeChats')}</Button>
                    <Button className="flex-1" onPress={() => setHistoryMode('archived')} size="sm" variant={historyMode === 'archived' ? 'primary' : 'ghost'}>{t('archivedChats')}</Button>
                  </div>
                </>
              )}
            </div>
            {railCollapsed ? null : loading ? (
              <div className="grid place-items-center py-12"><Spinner color="accent" /></div>
            ) : visibleItems.length === 0 ? (
              <p className="px-4 py-8 text-xs leading-5 text-muted">{t('empty')}</p>
            ) : (
              <div>
                {visibleItems.map((item) => {
                  const status = item.thread?.status ?? item.legacy?.status ?? 'completed'
                  const active = item.id === selectedId
                  return (
                    <button
                      aria-current={active ? 'page' : undefined}
                      className={`grid w-full cursor-pointer gap-1 border-b border-border px-4 py-3 text-left transition-colors hover:bg-surface-hover ${
                        active ? 'bg-primary-soft' : ''
                      }`}
                      key={item.id}
                      onClick={() => selectThread(item.id)}
                      type="button"
                    >
                      <span className="flex items-center gap-2">
                        {status === 'running' || status === 'cancelling'
                          ? <Spinner color="accent" size="sm" />
                          : <MessageSquareText aria-hidden="true" className="text-muted" size={15} />}
                        <strong className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {item.thread
                            ? item.thread.kind === 'native-chat'
                              ? item.thread.title
                              : threadTitle(item.thread.request, t)
                            : legacyTitle(item.legacy!, t)}
                        </strong>
                      </span>
                      <span className="flex items-center justify-between gap-2 pl-6 text-xs text-muted">
                        <span>{t(`status.${status}`, { defaultValue: status })}</span>
                        {!item.thread && <span>{t('legacy')}</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </aside>

          <main
            aria-label={t('conversation')}
            className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-background"
          >
            <section className="min-h-0 overflow-y-auto px-6 py-6" onScroll={updateFollowState} ref={conversationRef}>
              {!thread && !legacy && !isSending ? (
                <div className="grid h-full place-items-center text-sm text-muted">
                  {loading ? t('loading') : t('emptySelection')}
                </div>
              ) : thread?.kind === 'native-chat' ? (
                <NativeConversation
                  liveAssistant={liveAssistant}
                  liveTools={liveTools}
                  thread={thread}
                />
              ) : !thread && isSending ? (
                <LiveTurn assistant={liveAssistant} tools={liveTools} />
              ) : thread ? (
                <PersistedConversation thread={thread} />
              ) : (
                <LegacyConversation entry={legacy!} />
              )}
            </section>
            {!legacy && (!thread || (thread.kind === 'native-chat' && !thread.archivedAt)) && (
              <div className="border-t border-border p-4" data-chat-composer>
                <div className="mx-auto flex max-w-3xl items-end gap-3 rounded-xl border border-border bg-surface p-3">
                  <textarea
                    aria-label={t('message', { defaultValue: 'Message' })}
                    className="max-h-40 min-h-12 flex-1 resize-none bg-transparent text-sm text-foreground outline-none"
                    onChange={(event) => setComposer(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        sendChatMessage()
                      }
                    }}
                    placeholder={t('messagePlaceholder', { defaultValue: 'Message Claude…' })}
                    value={composer}
                  />
                  {isSending && (
                    <Button isIconOnly onPress={() => void stopChatTurn()} variant="ghost">
                      <Square aria-label={t('stopChat')} size={15} />
                    </Button>
                  )}
                  <Button className="bg-primary text-primary-foreground" isDisabled={!composer.trim()} onPress={sendChatMessage}>
                    {isSending ? t('queue', { count: queuedCount }) : t('send', { defaultValue: 'Send' })}
                  </Button>
                </div>
                <div className="mx-auto mt-2 flex max-w-3xl flex-wrap items-center gap-2 text-xs text-muted">
                  <Select
                    aria-label={t('agent')}
                    className="w-28"
                    isDisabled={thread?.kind === 'native-chat'}
                    onSelectionChange={(key) => setProvider(String(key) as ProviderId)}
                    selectedKey={thread?.kind === 'native-chat' ? thread.provider : provider}
                  >
                    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                    <Select.Popover><ListBox>
                      <ListBox.Item id="claude">{t('providerClaude')}</ListBox.Item>
                      <ListBox.Item id="codex">{t('providerCodex')}</ListBox.Item>
                    </ListBox></Select.Popover>
                  </Select>
                  <Select
                    aria-label={t('model')}
                    className="w-40"
                    onSelectionChange={(key) => setModel(String(key) === '__default' ? '' : String(key))}
                    selectedKey={model || '__default'}
                  >
                    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                    <Select.Popover><ListBox>
                      <ListBox.Item id="__default">{t('providerDefaultModel')}</ListBox.Item>
                      {(providerSnapshot.entries.find((entry) => entry.id === provider)?.models ?? []).map((entry) => (
                        <ListBox.Item id={entry.id} key={entry.id}>{entry.label}</ListBox.Item>
                      ))}
                    </ListBox></Select.Popover>
                  </Select>
                  <Select
                    aria-label={t('effort')}
                    className="w-28"
                    onSelectionChange={(key) => setEffort(String(key) as typeof effort)}
                    selectedKey={effort}
                  >
                    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                    <Select.Popover><ListBox>
                      {CHAT_EFFORTS.map((value) => (
                        <ListBox.Item id={value} key={value}>{value}</ListBox.Item>
                      ))}
                    </ListBox></Select.Popover>
                  </Select>
                  <Switch aria-label={t('fastMode')} isSelected={fastMode} onChange={setFastMode}>
                    <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
                  </Switch>
                  <Select
                    aria-label={t('skills')}
                    className="w-36"
                    onSelectionChange={(key) => {
                      const name = String(key)
                      setComposer((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}/${name} `)
                      setSelectedSkill(null)
                    }}
                    selectedKey={selectedSkill}
                  >
                    <Select.Trigger><Select.Value>{t('skills')}</Select.Value><Select.Indicator /></Select.Trigger>
                    <Select.Popover><ListBox>
                      {skills.map((skill) => (
                        <ListBox.Item id={skill.name} key={skill.name}>{skill.name}</ListBox.Item>
                      ))}
                    </ListBox></Select.Popover>
                  </Select>
                  <span>{t('fullAccess')}</span>
                  <span className="ml-auto">
                    {liveUsage
                      ? `${liveUsage.usedTokens} / ${liveUsage.maxTokens}`
                      : thread?.kind === 'native-chat' && thread.contextUsage
                        ? `${thread.contextUsage.usedTokens} / ${thread.contextUsage.maxTokens}`
                        : '—'}
                  </span>
                </div>
              </div>
            )}
          </main>

          <aside aria-label={t('context')} className={`min-h-0 overflow-x-hidden overflow-y-auto border-l border-border bg-surface p-5 max-[1180px]:fixed max-[1180px]:bottom-4 max-[1180px]:right-4 max-[1180px]:top-16 max-[1180px]:z-40 max-[1180px]:w-80 max-[1180px]:rounded-xl max-[1180px]:border max-[1180px]:shadow-xl ${compactContextOpen ? 'max-[1180px]:block' : 'max-[1180px]:hidden'}`}>
            <h2 className="text-sm font-medium text-foreground">{t('context')}</h2>
            {thread?.kind === 'native-chat' ? (
              <div className="mt-4 grid gap-4">
                <ContextDetail label={t('agent')} value={thread.provider === 'claude' ? 'Claude' : 'Codex'} />
                <ContextDetail label={t('model')} value={thread.defaultTurnConfig.model ?? t('providerDefaultModel')} />
                <ContextDetail label={t('effort')} value={thread.defaultTurnConfig.effort} />
                <ContextDetail label={t('workingDirectory')} value={t('workspace')} />
                <ContextDetail label={t('access')} value={t('fullAccess')} />
                <ContextDetail label={t('contextWindow')} value={thread.contextUsage
                  ? `${thread.contextUsage.usedTokens} / ${thread.contextUsage.maxTokens}`
                  : '—'} />
                <div className="grid gap-2 border-t border-border pt-4">
                  <div className="flex gap-2">
                    <input
                      aria-label={t('chatTitle')}
                      className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-2 text-xs text-foreground"
                      onChange={(event) => setRenameValue(event.target.value)}
                      value={renameValue}
                    />
                    <Button isDisabled={lifecycleBusy || !renameValue.trim()} isIconOnly onPress={() => void renameCurrentChat()} size="sm" variant="ghost">
                      <Pencil aria-label={t('renameChat')} size={14} />
                    </Button>
                  </div>
                  {thread.archivedAt ? (
                    <div className="flex gap-2">
                      <Button className="flex-1 gap-2" isDisabled={lifecycleBusy} onPress={() => void restoreCurrentChat()} size="sm" variant="ghost">
                        <ArchiveRestore size={14} />{t('restoreChat')}
                      </Button>
                      <Button className="gap-2 text-danger" isDisabled={lifecycleBusy} onPress={() => setDeleteConfirmThread(thread)} size="sm" variant="ghost">
                        <Trash2 size={14} />{t('deleteForever')}
                      </Button>
                    </div>
                  ) : (
                    <Button className="gap-2" isDisabled={lifecycleBusy} onPress={() => void archiveCurrentChat()} size="sm" variant="ghost">
                      <Archive size={14} />{t('archiveChat')}
                    </Button>
                  )}
                  {thread.nativeState === 'resume-failed' && (
                    <div className="grid gap-2 rounded-lg border border-danger/40 p-3">
                      <span className="text-xs text-danger">{t('resumeFailed')}</span>
                      <Button onPress={continueAsNewChat} size="sm" variant="ghost">{t('continueAsNew')}</Button>
                    </div>
                  )}
                </div>
              </div>
            ) : thread ? (
              <div className="mt-4 grid gap-4">
                <ContextDetail label={t('run')} value={thread.runId.slice(0, 8)} />
                <ContextDetail label={t('scope')} value={scopeLabel(thread.request, t)} />
                <ContextDetail
                  label={t('agent')}
                  value={
                    thread.request.provider === 'codex'
                      ? 'Codex'
                      : thread.request.provider === 'claude' ? 'Claude' : '—'
                  }
                />
                <ContextDetail
                  label={t('model')}
                  value={thread.request.model ?? t('providerDefaultModel')}
                />
                <ContextDetail label={t('effort')} value={thread.request.effort ?? '—'} />
                <ContextDetail
                  label={t('fastMode')}
                  value={
                    thread.request.fastMode === undefined
                      ? '—'
                      : thread.request.fastMode ? t('enabled') : t('disabled')
                  }
                />
                <ContextDetail label={t('projects')} value={String(thread.projectCount)} />
                <ContextDetail label={t('sessions')} value={String(thread.sessionCount)} />
                <ContextDetail label={t('candidates')} value={String(thread.candidateCount)} />
                <ContextDetail
                  label={t('updated')}
                  value={formatDateTime(thread.updatedAt, currentLocale())}
                />
                {(thread.status === 'running' || thread.status === 'cancelling') && (
                  <Button
                    className="mt-2 gap-2"
                    isDisabled={thread.status === 'cancelling'}
                    onPress={() => void stopGeneration()}
                    variant="ghost"
                  >
                    {thread.status === 'cancelling'
                      ? <Spinner color="current" size="sm" />
                      : <Square aria-hidden="true" size={14} />}
                    {thread.status === 'cancelling' ? t('cancelling') : t('stopGeneration')}
                  </Button>
                )}
              </div>
            ) : legacy ? (
              <div className="mt-4 grid gap-4">
                <Chip color="warning" size="sm" variant="soft">{t('legacy')}</Chip>
                <ContextDetail label={t('run')} value={legacy.id.slice(0, 8)} />
                <ContextDetail label={t('scope')} value={scopeLabel(legacy.request, t)} />
                <ContextDetail label={t('candidates')} value={String(legacy.candidateCount)} />
              </div>
            ) : null}
            {!legacy && (!thread || (thread.kind === 'native-chat' && !thread.archivedAt)) && (
              <SessionContextPicker
                cursor={contextCursor}
                from={contextFrom}
                items={contextItems}
                loading={contextLoading}
                onLoadMore={() => void loadContextSessions(true)}
                onProjectChange={setContextProject}
                onRangeChange={(nextFrom, nextTo) => {
                  setContextFrom(nextFrom)
                  setContextTo(nextTo)
                }}
                onRecentDays={selectRecentContextDays}
                onSelectedChange={(next) => void updateSelectedContext(next)}
                project={contextProject}
                projects={projects}
                selected={selectedContext}
                selectedItems={selectedContextItems}
                to={contextTo}
              />
            )}
            <p className="mt-6 border-t border-border pt-4 text-xs leading-5 text-muted">
              {t('privacy')}
            </p>
          </aside>
        </Card.Content>
      </Card>
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
  liveAssistant,
  liveTools,
}: {
  thread: Extract<ChatThread, { version: 2 }>
  liveAssistant: string
  liveTools: NativeToolActivity[]
}) {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6">
      {thread.messages.map((message) => message.role === 'user' ? (
        <div className="grid justify-items-end gap-1" key={message.id}>
          <div className="max-w-xl rounded-2xl rounded-tr-md bg-surface-hover px-4 py-3 text-sm leading-6 text-foreground">
            <p>{message.content}</p>
          </div>
          {message.turnConfig && <TurnConfigLine config={message.turnConfig} />}
        </div>
      ) : (
        <article className="grid gap-3 whitespace-pre-wrap text-sm leading-7 text-foreground" key={message.id}>
          {message.content}
          <ToolActivityList activities={message.toolActivities ?? []} chatId={thread.id} />
        </article>
      ))}
      {thread.status === 'running' && <LiveTurn assistant={liveAssistant} chatId={thread.id} tools={liveTools} />}
      {thread.lastError && <Alert status="danger"><Alert.Description>{thread.lastError}</Alert.Description></Alert>}
    </div>
  )
}

function LiveTurn({
  assistant,
  tools,
  chatId,
}: {
  assistant: string
  tools: NativeToolActivity[]
  chatId?: string
}) {
  return (
    <article className="mx-auto grid w-full max-w-3xl gap-3 text-sm leading-7 text-foreground">
      {assistant && <p className="whitespace-pre-wrap">{assistant}</p>}
      <ToolActivityList activities={tools} chatId={chatId} />
      <Spinner color="accent" size="sm" />
    </article>
  )
}

function ToolActivityList({ activities, chatId }: {
  activities: NativeToolActivity[]
  chatId?: string
}) {
  if (activities.length === 0) return null
  return (
    <div className="grid gap-2" role="list">
      {activities.map((activity) => (
        <NativeToolCard activity={activity} chatId={chatId} key={activity.itemId} />
      ))}
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
  return (
    <Card className="border border-border bg-surface shadow-none" role="listitem">
      <Card.Content className="p-3">
        <button className="flex w-full items-center gap-2 text-left" onClick={toggle} type="button">
          <Icon aria-hidden="true" className="text-muted" size={15} />
          <strong className="text-xs font-medium text-foreground">{activity.name}</strong>
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{activity.summary}</span>
          {activity.status === 'running' ? <Spinner color="accent" size="sm" /> : (
            <ChevronRight className={expanded ? 'rotate-90' : ''} size={14} />
          )}
        </button>
        {expanded && (
          <div className="mt-3 border-t border-border pt-3">
            {loading && !content ? <Spinner color="accent" size="sm" /> : available ? (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-5 text-muted">{content}</pre>
            ) : <p className="text-xs text-muted">{t('toolSourceUnavailable')}</p>}
            {nextCursor !== null && nextCursor > 0 && (
              <Button className="mt-2" isDisabled={loading} onPress={() => void loadPage(nextCursor)} size="sm" variant="ghost">
                {t('loadMore')}
              </Button>
            )}
          </div>
        )}
      </Card.Content>
    </Card>
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
    <div className="mx-auto grid w-full max-w-3xl gap-6">
      <div className="flex justify-end">
        <div className="max-w-xl rounded-2xl rounded-tr-md bg-surface-hover px-4 py-3 text-sm leading-6 text-foreground">
          {userMessage?.kind === 'rules-generation-request'
            ? requestMessage(thread.request, t)
            : userMessage?.content ?? scopeLabel(thread.request, t)}
        </div>
      </div>
      <article className="min-w-0">
        <div className="min-w-0">
          {assistantContent ? (
            <p className="whitespace-pre-wrap text-sm leading-7 text-foreground">
              {assistantContent}
            </p>
          ) : null}
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
        </div>
      </article>
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

function RunningElapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="mt-5 flex items-center gap-2 text-sm text-muted">
      <Spinner color="accent" size="sm" />
      <span>{formatElapsed(startedAt, now)}</span>
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
    <div className="mx-auto grid w-full max-w-3xl gap-6">
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
  const rowHeight = 58
  const viewportHeight = 290
  const overscan = 4
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(items.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan)
  const visibleItems = items.slice(start, end)
  const selectedKeys = new Set(selected.map(sessionReferenceKey))
  const knownItems = new Map(selectedItems.map((item) => [sessionReferenceKey(item), item]))
  const projectOptions = ['default', ...projects.map((item) => item.slug)]
    .filter((value, index, values) => values.indexOf(value) === index)

  return (
    <div className="mt-6 border-t border-border pt-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{t('sessionContext')}</h3>
        <Chip size="sm" variant="soft">{selected.length}</Chip>
      </div>
      <Select
        aria-label={t('contextProject')}
        className="mt-3"
        onSelectionChange={(key) => onProjectChange(String(key))}
        selectedKey={project}
      >
        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover><ListBox>
          <ListBox.Item id="all">{t('allProjects')}</ListBox.Item>
          {projectOptions.map((slug) => (
            <ListBox.Item id={slug} key={slug}>{slug === 'default' ? t('defaultProject') : slug}</ListBox.Item>
          ))}
        </ListBox></Select.Popover>
      </Select>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <input
          aria-label={t('contextFrom')}
          className="min-w-0 rounded-lg border border-border bg-surface px-2 py-2 text-xs text-foreground"
          onChange={(event) => onRangeChange(event.target.value, to)}
          type="date"
          value={from}
        />
        <input
          aria-label={t('contextTo')}
          className="min-w-0 rounded-lg border border-border bg-surface px-2 py-2 text-xs text-foreground"
          onChange={(event) => onRangeChange(from, event.target.value)}
          type="date"
          value={to}
        />
      </div>
      <div className="mt-2 flex gap-2">
        <Button onPress={() => onRecentDays(7)} size="sm" variant="ghost">{t('recent7Days')}</Button>
        <Button onPress={() => onRecentDays(30)} size="sm" variant="ghost">{t('recent30Days')}</Button>
        {(from || to) && (
          <Button onPress={() => onRangeChange('', '')} size="sm" variant="ghost">{t('clearRange')}</Button>
        )}
      </div>
      {selected.length > 0 && (
        <div className="mt-3 grid gap-1">
          <span className="text-xs font-medium text-muted">{t('selectedSessions')}</span>
          {selected.map((reference) => {
            const item = knownItems.get(sessionReferenceKey(reference))
            return (
              <button
                className="flex w-full min-w-0 items-center gap-2 rounded-md bg-surface-hover px-2 py-1 text-left text-xs"
                key={sessionReferenceKey(reference)}
                onClick={() => onSelectedChange(selected.filter(
                  (current) => sessionReferenceKey(current) !== sessionReferenceKey(reference),
                ))}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{reference.agent} · {reference.id}</span>
                {item && !item.sourceAvailable && <span className="text-danger">{t('sourceMissing')}</span>}
                <span aria-label={t('removeSession')}>×</span>
              </button>
            )
          })}
        </div>
      )}
      <div
        className="relative mt-3 overflow-y-auto rounded-lg border border-border"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        style={{ height: viewportHeight }}
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
                  type="button"
                >
                  {active ? <CheckCircle2 className="shrink-0 text-primary" size={14} /> : <span className="size-3.5 shrink-0 rounded-full border border-border" />}
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate font-medium text-foreground">{item.agent} · {item.id}</strong>
                    <span className="block truncate text-muted">{item.slug} · {formatDateTime(item.updatedAt, currentLocale())}</span>
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

function mergeNativeToolActivity(
  current: NativeToolActivity[],
  incoming: NativeToolActivity,
): NativeToolActivity[] {
  const index = current.findIndex((activity) => activity.itemId === incoming.itemId)
  if (index < 0) return [...current, incoming]
  return current.map((activity, itemIndex) => itemIndex === index ? incoming : activity)
}

function isNativeChatEvent(value: unknown): value is NativeChatEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  if (event.type === 'assistant_delta') return typeof event.text === 'string'
  if (event.type === 'usage') {
    if (!event.contextUsage || typeof event.contextUsage !== 'object') return false
    const usage = event.contextUsage as Record<string, unknown>
    return typeof usage.usedTokens === 'number' && typeof usage.maxTokens === 'number'
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
