import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Chip, Spinner } from '@heroui/react'
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
  GenerationHistoryEntry,
  RunCancelResult,
} from '../types'
import {
  formatElapsed,
  mergeTimelineActivities,
  shouldFollowStream,
  visibleProjectResponses,
} from './chat-view-model'

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
  const selectedIdRef = useRef<string | null>(selectedId)
  const conversationRef = useRef<HTMLElement | null>(null)
  const followStreamRef = useRef(true)

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

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
  }, [thread?.activities.length, thread?.messages.length, thread?.status])

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
    if (!thread || (thread.status !== 'running' && thread.status !== 'cancelling')) return
    try {
      await window.api.invoke<RunCancelResult>(
        'rules.generate.cancel',
        { runId: thread.runId },
      )
      await refresh(thread.id)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  function selectThread(id: string): void {
    setSelectedId(id)
    selectedIdRef.current = id
    void refresh(id)
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
          {thread?.status === 'completed' && thread.candidateCount > 0 && (
            <Button
              className="gap-2 bg-primary text-primary-foreground"
              onPress={() => onOpenGeneratedRules(thread.runId)}
            >
              {t('openGeneratedRules')}
              <ChevronRight aria-hidden="true" size={17} />
            </Button>
          )}
        </header>

        {error && (
          <Alert className="mb-4" status="danger">
            <Alert.Content>
              <Alert.Title>{t('loadError')}</Alert.Title>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </div>

      <Card className="min-h-0 overflow-hidden border border-border bg-surface shadow-none">
        <Card.Content className="grid h-full min-h-0 grid-cols-[14rem_minmax(0,1fr)_17rem] p-0 max-[1180px]:grid-cols-[12rem_minmax(0,1fr)] max-[1180px]:grid-rows-[minmax(0,1fr)_auto]">
          <aside aria-label={t('threadRail')} className="min-h-0 overflow-y-auto border-r border-border bg-sidebar/40">
            <div className="sticky top-0 z-10 border-b border-border bg-surface px-4 py-3">
              <strong className="text-xs font-medium uppercase tracking-wide text-muted">
                {t('threadRail')}
              </strong>
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
                            ? threadTitle(item.thread.request, t)
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
            className="min-h-0 overflow-y-auto bg-background px-6 py-6"
            onScroll={updateFollowState}
            ref={conversationRef}
          >
            {!thread && !legacy ? (
              <div className="grid h-full place-items-center text-sm text-muted">
                {loading ? t('loading') : t('emptySelection')}
              </div>
            ) : thread ? (
              <PersistedConversation thread={thread} />
            ) : (
              <LegacyConversation entry={legacy!} />
            )}
          </main>

          <aside aria-label={t('context')} className="min-h-0 overflow-y-auto border-l border-border p-5 max-[1180px]:col-start-2 max-[1180px]:max-h-52 max-[1180px]:border-l-0 max-[1180px]:border-t">
            <h2 className="text-sm font-medium text-foreground">{t('context')}</h2>
            {thread ? (
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

function PersistedConversation({ thread }: { thread: ChatThread }) {
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

function ActivityTimeline({ thread }: { thread: ChatThread }) {
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
  activity: ChatThread['activities'][number]
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
  status: ChatThread['status'],
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
