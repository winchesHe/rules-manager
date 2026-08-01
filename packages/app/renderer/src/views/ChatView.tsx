import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Chip, ListBox, Select, Spinner, Switch } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Eye,
  FilePenLine,
  MessageSquareText,
  RotateCcw,
  Search,
  Square,
  SquareTerminal,
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
  RunCancelResult,
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
  const selectedIdRef = useRef<string | null>(selectedId)
  const liveChatIdRef = useRef<string | null>(null)
  const sendingRef = useRef(false)
  const queueRef = useRef<QueuedChatTurn[]>([])
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
    if (thread?.kind !== 'native-chat') return
    setProvider(thread.provider)
    setModel(thread.defaultTurnConfig.model ?? '')
    setEffort(thread.defaultTurnConfig.effort)
    setFastMode(thread.defaultTurnConfig.fastMode)
  }, [thread?.id])

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
      if (selectedIdRef.current && selectedIdRef.current !== envelope.chatId) return
      if (!selectedIdRef.current && !sendingRef.current) return
      liveChatIdRef.current = envelope.chatId
      if (envelope.event.type === 'assistant_delta') {
        setLiveAssistant((current) => `${current}${envelope.event.text}`)
      } else if (envelope.event.type === 'tool_activity') {
        setLiveTools((current) => mergeNativeToolActivity(current, envelope.event.activity))
      } else {
        setLiveUsage(envelope.event.contextUsage)
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

  const items = useMemo(() => {
    const persistedIds = new Set(threads.map((item) => item.id))
    return [
      ...threads.map((item) => ({ id: item.id, thread: item, legacy: undefined })),
      ...history
        .filter((item) => !persistedIds.has(item.id))
        .map((item) => ({ id: item.id, thread: undefined, legacy: item })),
    ]
  }, [history, threads])

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
    setSelectedId(id)
    selectedIdRef.current = id
    void refresh(id)
  }

  function startDraft(): void {
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

  function sendChatMessage(): void {
    const message = composer.trim()
    if (!message) return
    if (thread && thread.kind !== 'native-chat') return
    const turn: QueuedChatTurn = {
      message,
      provider: thread?.provider ?? provider,
      config: { ...(model ? { model } : {}), effort, fastMode },
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
        <Card.Content className="grid h-full min-h-0 grid-cols-[14rem_minmax(0,1fr)_17rem] p-0 max-[1180px]:grid-cols-[12rem_minmax(0,1fr)] max-[1180px]:grid-rows-[minmax(0,1fr)_auto]">
          <aside aria-label={t('threadRail')} className="min-h-0 overflow-x-hidden overflow-y-auto border-r border-border bg-sidebar/40">
            <div className="sticky top-0 z-10 border-b border-border bg-surface px-4 py-3">
              <Button className="mb-3 bg-primary text-primary-foreground" fullWidth onPress={startDraft}>
                {t('newChat', { defaultValue: 'New Chat' })}
              </Button>
              <strong className="text-xs font-medium uppercase tracking-wide text-muted">{t('threadRail')}</strong>
            </div>
            {loading ? (
              <div className="grid place-items-center py-12"><Spinner color="accent" /></div>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-xs leading-5 text-muted">{t('empty')}</p>
            ) : (
              <div>
                {items.map((item) => {
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
            {!legacy && (!thread || thread.kind === 'native-chat') && (
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

          <aside aria-label={t('context')} className="min-h-0 overflow-y-auto border-l border-border p-5 max-[1180px]:col-start-2 max-[1180px]:max-h-52 max-[1180px]:border-l-0 max-[1180px]:border-t">
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
            <p className="mt-6 border-t border-border pt-4 text-xs leading-5 text-muted">
              {t('privacy')}
            </p>
          </aside>
        </Card.Content>
      </Card>
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

function ContextDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="break-words text-sm text-foreground">{value}</span>
    </div>
  )
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
