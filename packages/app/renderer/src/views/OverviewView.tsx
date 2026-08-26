import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Chip, Spinner, Table } from '@heroui/react'
import { ArrowLeft, History as HistoryIcon, ScanLine } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { afterNextPaint } from '../async'
import { PageHeader } from '../components/PageHeader'
import { EntranceTransition, FilterTransition, PageTransition } from '../components/UxTransition'
import { ViewError } from '../components/ViewStates'
import { formatDateTime } from '../i18n/format'
import { currentLocale, i18n } from '../i18n'
import type {
  AgentName,
  ScanPhase,
  ScanHistoryEntry,
  ScanProgress,
  RunCancelResult,
  RunState,
  ScanScope,
  ScanStartRequest,
  ScanStartResult,
  ScanStatus,
  ScanSummary,
} from '../types'
import { groupScanChanges } from '../view-models'

const agents: AgentName[] = ['claude', 'codex', 'copilot', 'cursor', 'opencode', 'pi']
type AgentState = ScanProgress | { agent: AgentName; phase: 'waiting' }
type ScanPage = 'latest' | 'create' | 'history'
type ChangeFilter = 'all' | 'new' | 'updated' | 'missing'
type ScanRange = 'full' | 'recent'

export function OverviewView({
  onOpenProject,
}: {
  onOpenProject?: (slug: string) => void
}) {
  const { t } = useTranslation('scan')
  const [page, setPage] = useState<ScanPage>('latest')
  const [selectedAgents, setSelectedAgents] = useState<AgentName[]>(agents)
  const [scanRange, setScanRange] = useState<ScanRange>('full')
  const [scanDays, setScanDays] = useState('7')
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanState, setScanState] = useState<RunState>('idle')
  const [scanRunId, setScanRunId] = useState<string | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanNotice, setScanNotice] = useState<string | null>(null)
  const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null)
  const [completedAt, setCompletedAt] = useState<string | null>(null)
  const [history, setHistory] = useState<ScanHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [selectedHistory, setSelectedHistory] = useState<ScanHistoryEntry | null>(null)
  const [agentStates, setAgentStates] = useState<Record<AgentName, AgentState> | null>(null)
  const [filter, setFilter] = useState<ChangeFilter>('all')
  const mounted = useRef(true)
  const selectedAgentsRef = useRef(selectedAgents)

  useEffect(() => {
    selectedAgentsRef.current = selectedAgents
  }, [selectedAgents])

  useEffect(() => {
    let current = true
    mounted.current = true

    const onProgress = (value: unknown) => {
      if (!isScanProgress(value)) return
      setScanning(true)
      setScanState('running')
      setScanRunId(scanEventRunId(value) ?? null)
      setScanError(null)
      setScanNotice(null)
      setPage('latest')
      setAgentStates((previous) => ({
        ...(previous ?? createWaitingStates(selectedAgentsRef.current)),
        [value.agent]: value,
      }))
    }
    const onDone = (value: unknown) => {
      if (!isScanSummary(value)) return
      setSelectedHistory(null)
      setScanSummary(value)
      setCompletedAt(new Date().toISOString())
      setScanning(false)
      setScanState('completed')
      setScanRunId(scanEventRunId(value) ?? null)
      setPage('latest')
    }
    const onCancelled = (value: unknown) => {
      setScanning(false)
      setScanState('cancelled')
      setScanRunId(scanEventRunId(value) ?? null)
      setScanNotice(i18n.t('scan:notices.cancelled'))
      setPage('latest')
      void restoreLatestScan()
    }
    const onFailed = (value: unknown) => {
      const message =
        typeof value === 'object' &&
        value !== null &&
        'message' in value &&
        typeof value.message === 'string'
          ? value.message
          : i18n.t('scan:errors.failed')
      setScanError(message)
      setScanning(false)
      setScanState('failed')
      setScanRunId(scanEventRunId(value) ?? null)
      setPage('latest')
    }
    window.api.onEvent('scan.progress', onProgress)
    window.api.onEvent('scan.done', onDone)
    window.api.onEvent('scan.cancelled', onCancelled)
    window.api.onEvent('scan.failed', onFailed)

    setError(null)
    void afterNextPaint(() => window.api.invoke<ScanStatus>('scan.status'))
      .then((status) => {
        if (!current) return
        setScanning(status.running)
        setScanState(status.state)
        setScanRunId(status.runId ?? null)
        setScanSummary(status.summary ?? null)
        setCompletedAt(status.completedAt ?? null)
        setScanError(status.error ?? null)
        if (status.selectedAgents?.length) setSelectedAgents(status.selectedAgents)
        if (status.sinceDays !== undefined) {
          setScanRange('recent')
          setScanDays(String(status.sinceDays))
        } else if (status.summary) {
          setScanRange('full')
        }
        if (status.progressByAgent) {
          const selected = status.selectedAgents?.length ? status.selectedAgents : agents
          const states = createWaitingStates(selected)
          Object.assign(states, status.progressByAgent)
          setAgentStates(states)
        }
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      current = false
      mounted.current = false
      window.api.offEvent('scan.progress', onProgress)
      window.api.offEvent('scan.done', onDone)
      window.api.offEvent('scan.cancelled', onCancelled)
      window.api.offEvent('scan.failed', onFailed)
    }
  }, [])

  async function restoreLatestScan(): Promise<void> {
    try {
      const status = await window.api.invoke<ScanStatus>('scan.status')
      if (!mounted.current) return
      setScanSummary(status.summary ?? null)
      setCompletedAt(status.completedAt ?? null)
    } catch (reason: unknown) {
      if (mounted.current) {
        setScanError(reason instanceof Error ? reason.message : String(reason))
      }
    }
  }

  const displayedSummary = selectedHistory?.summary ?? scanSummary
  const displayedCompletedAt = selectedHistory?.completedAt ?? completedAt
  const changes = useMemo(() => {
    if (!displayedSummary) return []
    return groupScanChanges(displayedSummary).filter((row) => {
      if (filter === 'new') return row.newCount > 0
      if (filter === 'updated') return row.updatedCount > 0
      if (filter === 'missing') return row.missingCount > 0
      return true
    })
  }, [displayedSummary, filter])

  function toggleAgent(agent: AgentName): void {
    setSelectedAgents((current) =>
      current.includes(agent)
        ? current.filter((item) => item !== agent)
        : [...current, agent],
    )
  }

  async function handleScan(): Promise<void> {
    const sinceDays = scanRange === 'recent' ? parseScanDays(scanDays) : undefined
    if (selectedAgents.length === 0 || (scanRange === 'recent' && sinceDays === undefined)) {
      return
    }
    setScanning(true)
    setScanState('running')
    setSelectedHistory(null)
    setScanError(null)
    setScanNotice(null)
    setAgentStates(createWaitingStates(selectedAgents))
    setPage('latest')

    try {
      const result = await afterNextPaint(() =>
        window.api.invoke<ScanStartResult>('scan.run', {
          agents: selectedAgents,
          sinceDays,
        } satisfies ScanStartRequest),
      )
      if (!mounted.current) return
      if (result.started) {
        setScanRunId(result.runId)
        return
      }
      const status = await window.api.invoke<ScanStatus>('scan.status')
      if (mounted.current) {
        setScanning(status.running)
        setScanState(status.state)
        setScanRunId(status.runId ?? null)
      }
    } catch (reason: unknown) {
      if (mounted.current) {
        setScanError(reason instanceof Error ? reason.message : String(reason))
        setScanning(false)
        setScanState('failed')
      }
    }
  }

  async function cancelScan(): Promise<void> {
    if (!scanRunId || scanState !== 'running') return
    setScanState('cancelling')
    setScanError(null)
    try {
      const result = await window.api.invoke<RunCancelResult>(
        'scan.cancel',
        { runId: scanRunId },
      )
      if (!result.accepted && 'reason' in result && result.reason !== 'already-cancelling') {
        const status = await window.api.invoke<ScanStatus>('scan.status')
        if (!mounted.current) return
        setScanning(status.running)
        setScanState(status.state)
        setScanRunId(status.runId ?? null)
      }
    } catch (reason: unknown) {
      if (!mounted.current) return
      setScanError(reason instanceof Error ? reason.message : String(reason))
      const status = await window.api.invoke<ScanStatus>('scan.status')
      setScanning(status.running)
      setScanState(status.state)
      setScanRunId(status.runId ?? null)
    }
  }

  async function openHistory(): Promise<void> {
    setPage('history')
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const runs = await afterNextPaint(() =>
        window.api.invoke<ScanHistoryEntry[]>('scan.history'),
      )
      if (mounted.current) setHistory(runs)
    } catch (reason: unknown) {
      if (mounted.current) {
        setHistoryError(
          isMissingScanHistoryHandler(reason)
            ? i18n.t('scan:errors.historyVersion')
            : reason instanceof Error ? reason.message : String(reason),
        )
      }
    } finally {
      if (mounted.current) setHistoryLoading(false)
    }
  }

  function viewHistory(entry: ScanHistoryEntry): void {
    setSelectedHistory(entry)
    setFilter('all')
    setPage('latest')
  }

  if (error) return <ViewError message={error} title={t('errors.loadStatus')} />

  if (page === 'history') {
    return (
      <PageTransition transitionKey="scan:history">
        <Button
          className="mb-5 gap-2 text-muted"
          onPress={() => {
            setSelectedHistory(null)
            setPage('latest')
          }}
          variant="ghost"
        >
          <ArrowLeft aria-hidden="true" size={17} />
          {t('history.back')}
        </Button>
        <PageHeader
          description={t('history.description')}
          title={t('history.title')}
        />
        <div className="mb-4">
          <Chip size="sm" variant="soft">{t('history.all')}</Chip>
        </div>
        <Card className="min-h-64 border border-border bg-surface shadow-none">
          <Card.Content className="p-0">
            {historyLoading ? (
              <div className="grid min-h-64 place-items-center">
                <Spinner aria-label={t('loading.history')} color="accent" size="sm" />
              </div>
            ) : historyError ? (
              <div className="p-5">
                <Alert status="danger">
                  <Alert.Content>
                    <Alert.Title>{t('errors.loadHistory')}</Alert.Title>
                    <Alert.Description>{historyError}</Alert.Description>
                  </Alert.Content>
                </Alert>
              </div>
            ) : history.length === 0 ? (
              <div className="grid min-h-64 place-items-center text-sm text-muted">
                {t('history.empty')}
              </div>
            ) : (
              <Table className="rounded-none bg-transparent shadow-none">
                <Table.ScrollContainer>
                  <Table.Content
                    aria-label={t('history.tableLabel')}
                    onRowAction={(key) => {
                      const entry = history.find((item) => item.id === String(key))
                      if (entry) viewHistory(entry)
                    }}
                  >
                    <Table.Header>
                      <Table.Column isRowHeader>{t('columns.completed')}</Table.Column>
                      <Table.Column>{t('columns.status')}</Table.Column>
                      <Table.Column>{t('columns.scope')}</Table.Column>
                      <Table.Column>{t('columns.sessions')}</Table.Column>
                      <Table.Column>{t('columns.new')}</Table.Column>
                      <Table.Column>{t('columns.updated')}</Table.Column>
                      <Table.Column>{t('columns.errors')}</Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {history.map((entry) => (
                        <Table.Row
                          aria-label={t('history.viewRow', {
                            time: formatCompletedAt(entry.completedAt),
                          })}
                          className="cursor-pointer rounded-none outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [&>td]:rounded-none"
                          id={entry.id}
                          key={entry.id}
                        >
                          <Table.Cell className="font-medium">
                            {formatCompletedAt(entry.completedAt)}
                          </Table.Cell>
                          <Table.Cell>
                            <Chip
                              color={
                                entry.status === 'success'
                                  ? 'success'
                                  : 'warning'
                              }
                              size="sm"
                              variant="soft"
                            >
                              {t(`common:status.${entry.status}`, { defaultValue: entry.status })}
                            </Chip>
                          </Table.Cell>
                          <Table.Cell>{formatScanScope(entry.scope)}</Table.Cell>
                          <Table.Cell>{entry.summary.total}</Table.Cell>
                          <Table.Cell>{entry.summary.new || '—'}</Table.Cell>
                          <Table.Cell>{entry.summary.updated || '—'}</Table.Cell>
                          <Table.Cell>{entry.summary.errors || '—'}</Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            )}
          </Card.Content>
        </Card>
      </PageTransition>
    )
  }

  if (page === 'create') {
    return (
      <PageTransition transitionKey="scan:create">
        <Button className="mb-5 gap-2 text-muted" onPress={() => setPage('latest')} variant="ghost">
          <ArrowLeft aria-hidden="true" size={17} />
          {t('create.back')}
        </Button>
        <PageHeader
          description={t('create.description')}
          title={t('create.title')}
        />
        <Card className="border border-border bg-surface shadow-none">
          <Card.Content className="grid gap-6 p-6">
            <div>
              <h2 className="font-medium text-foreground">{t('create.scopeTitle')}</h2>
              <p className="mt-1 text-sm text-muted">
                {t('create.scopeDescription')}
              </p>
              <div aria-label={t('create.rangeLabel')} className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  aria-pressed={scanRange === 'full'}
                  onPress={() => setScanRange('full')}
                  size="sm"
                  variant={scanRange === 'full' ? 'primary' : 'ghost'}
                >
                  {t('create.fullHistory')}
                </Button>
                <Button
                  aria-pressed={scanRange === 'recent'}
                  onPress={() => setScanRange('recent')}
                  size="sm"
                  variant={scanRange === 'recent' ? 'primary' : 'ghost'}
                >
                  {t('create.lastDays')}
                </Button>
                {scanRange === 'recent' && (
                  <label className="ml-1 flex items-center gap-2 text-sm text-muted">
                    <input
                      aria-label={t('create.daysLabel')}
                      className="h-9 w-20 rounded-lg border border-border bg-surface px-3 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                      inputMode="numeric"
                      min={1}
                      onChange={(event) => setScanDays(event.target.value)}
                      step={1}
                      type="number"
                      value={scanDays}
                    />
                    {t('create.daysUnit')}
                  </label>
                )}
              </div>
            </div>
            <div className="border-t border-border pt-5">
              <div className="mb-3">
                <h2 className="font-medium text-foreground">{t('create.agentsTitle')}</h2>
                <p className="mt-1 text-sm text-muted">
                  {t('create.agentsDescription')}
                </p>
              </div>
              <div aria-label={t('create.agentsLabel')} className="flex flex-wrap gap-2">
                {agents.map((agent) => {
                  const selected = selectedAgents.includes(agent)
                  return (
                    <Button
                      aria-pressed={selected}
                      key={agent}
                      onPress={() => toggleAgent(agent)}
                      size="sm"
                      variant={selected ? 'primary' : 'ghost'}
                    >
                      <span className="capitalize">{agent}</span>
                    </Button>
                  )
                })}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
              <span className="text-sm text-muted">
                {selectedAgents.length === 0
                  ? t('create.selectAgent')
                  : scanRange === 'recent'
                    ? t('create.summaryRecent', {
                        count: selectedAgents.length,
                        days: scanDays || '—',
                      })
                    : t('create.summaryFull', { count: selectedAgents.length })}
              </span>
              <Button
                className="gap-2 bg-primary text-primary-foreground"
                isDisabled={
                  selectedAgents.length === 0 ||
                  scanning ||
                  (scanRange === 'recent' && parseScanDays(scanDays) === undefined)
                }
                onPress={() => void handleScan()}
              >
                <ScanLine aria-hidden="true" size={17} />
                {t('create.start')}
              </Button>
            </div>
          </Card.Content>
        </Card>
      </PageTransition>
    )
  }

  return (
    <PageTransition transitionKey={`scan:latest:${selectedHistory?.id ?? 'current'}`}>
      <PageHeader
        actions={
          <div className="flex items-center gap-2">
            <Button
              className="gap-2"
              onPress={() => void openHistory()}
              variant="ghost"
            >
              <HistoryIcon aria-hidden="true" size={17} />
              {selectedHistory ? t('history.backToHistory') : t('history.action')}
            </Button>
            <Button
              className="gap-2 bg-primary text-primary-foreground"
              isDisabled={scanning}
              onPress={() => {
                setSelectedHistory(null)
                setPage('create')
              }}
            >
              <ScanLine aria-hidden="true" size={17} />
              {t('latest.newScan')}
            </Button>
          </div>
        }
        description={
          selectedHistory
            ? t('latest.historicalDescription')
            : displayedSummary
            ? t('latest.resultDescription')
            : t('latest.emptyDescription')
        }
        title={
          scanState === 'cancelling'
            ? t('latest.stoppingTitle')
            : scanning
              ? t('latest.progressTitle')
            : selectedHistory
              ? t('latest.resultTitle')
              : displayedSummary ? t('latest.latestTitle') : t('latest.title')
        }
      />

      {scanError && (
        <div className="mb-4">
          <Alert status="danger">
            <Alert.Content>
              <Alert.Title>{t('errors.failed')}</Alert.Title>
              <Alert.Description>{scanError}</Alert.Description>
            </Alert.Content>
          </Alert>
        </div>
      )}

      {scanNotice && (
        <div className="mb-4">
          <Alert status="warning">
            <Alert.Content>
              <Alert.Description>{scanNotice}</Alert.Description>
            </Alert.Content>
          </Alert>
        </div>
      )}

      {scanning && agentStates ? (
        <EntranceTransition delay={110}>
          <ScanProgressPanel
            agentStates={agentStates}
            onCancel={() => void cancelScan()}
            state={scanState}
          />
        </EntranceTransition>
      ) : displayedSummary ? (
        <>
          <EntranceTransition delay={50}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <Chip size="sm" variant="soft">{t('summary.sessions', { count: displayedSummary.total })}</Chip>
              <Chip color="success" size="sm" variant="soft">{t('summary.new', { count: displayedSummary.new })}</Chip>
              <Chip color="warning" size="sm" variant="soft">{t('summary.updated', { count: displayedSummary.updated })}</Chip>
              <Chip size="sm" variant="soft">{t('summary.missing', { count: displayedSummary.missing })}</Chip>
              {displayedSummary.errors > 0 && (
                <Chip color="danger" size="sm" variant="soft">{t('summary.errors', { count: displayedSummary.errors })}</Chip>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {selectedHistory && (
                <Chip
                  color={selectedHistory.status === 'success' ? 'success' : 'warning'}
                  size="sm"
                  variant="soft"
                >
                  {t(`common:status.${selectedHistory.status}`, {
                    defaultValue: selectedHistory.status,
                  })}
                </Chip>
              )}
              {displayedCompletedAt && (
                <span className="text-xs text-muted">
                  {t('latest.completedAt', { time: formatCompletedAt(displayedCompletedAt) })}
                </span>
              )}
              <div aria-label={t('latest.filterLabel')} className="flex flex-wrap gap-1">
                {(['all', 'new', 'updated', 'missing'] as const).map((item) => (
                  <Button
                    aria-pressed={filter === item}
                    key={item}
                    onPress={() => setFilter(item)}
                    size="sm"
                    variant={filter === item ? 'primary' : 'ghost'}
                  >
                    <span>{t(`filters.${item}`)}</span>
                  </Button>
                ))}
              </div>
            </div>
            </div>
          </EntranceTransition>
          <EntranceTransition delay={110}>
            <FilterTransition transitionKey={`scan-changes:${filter}`}>
              <Card className="border border-border bg-surface shadow-none">
              <Card.Content className="p-0">
              {changes.length === 0 ? (
                <div className="grid min-h-52 place-items-center text-sm text-muted">
                  {t('latest.emptyFilter')}
                </div>
              ) : (
                <Table className="rounded-none bg-transparent shadow-none">
                  <Table.ScrollContainer>
                    <Table.Content
                      aria-label={t('latest.changesTableLabel')}
                      onRowAction={(key) => onOpenProject?.(String(key))}
                    >
                      <Table.Header>
                        <Table.Column isRowHeader>{t('columns.project')}</Table.Column>
                        <Table.Column>{t('columns.agents')}</Table.Column>
                        <Table.Column>{t('columns.new')}</Table.Column>
                        <Table.Column>{t('columns.updated')}</Table.Column>
                        <Table.Column>{t('columns.missing')}</Table.Column>
                        <Table.Column>{t('columns.actions')}</Table.Column>
                      </Table.Header>
                      <Table.Body>
                        {changes.map((row) => (
                          <Table.Row
                            aria-label={t('latest.viewProjectSessions', { project: row.slug })}
                            className="cursor-pointer rounded-none outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [&>td]:rounded-none"
                            id={row.slug}
                            key={row.slug}
                          >
                            <Table.Cell className="font-medium">{row.slug}</Table.Cell>
                            <Table.Cell className="text-muted">
                              {row.agents.join(' · ')}
                            </Table.Cell>
                            <Table.Cell>{row.newCount || '—'}</Table.Cell>
                            <Table.Cell>{row.updatedCount || '—'}</Table.Cell>
                            <Table.Cell>{row.missingCount || '—'}</Table.Cell>
                            <Table.Cell>
                              <Button
                                onPress={() => onOpenProject?.(row.slug)}
                                size="sm"
                                variant="ghost"
                              >
                                {t('latest.viewSessions')}
                              </Button>
                            </Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Content>
                  </Table.ScrollContainer>
                </Table>
              )}
              </Card.Content>
              </Card>
            </FilterTransition>
          </EntranceTransition>
        </>
      ) : (
        <EntranceTransition delay={110}>
          <Card className="border border-border bg-surface shadow-none">
            <Card.Content className="grid min-h-64 place-items-center content-center gap-4 text-center">
              <ScanLine aria-hidden="true" className="text-muted" size={28} />
              <div>
                <p className="font-medium text-foreground">{t('latest.firstTitle')}</p>
                <p className="mt-1 text-sm text-muted">
                  {t('latest.firstDescription')}
                </p>
              </div>
              <Button
                className="bg-primary text-primary-foreground"
                onPress={() => setPage('create')}
              >
                {t('latest.configureFirst')}
              </Button>
            </Card.Content>
          </Card>
        </EntranceTransition>
      )}
    </PageTransition>
  )
}

function ScanProgressPanel({
  agentStates,
  onCancel,
  state,
}: {
  agentStates: Record<AgentName, AgentState>
  onCancel: () => void
  state: RunState
}) {
  const { t } = useTranslation('scan')
  const visibleStates = Object.values(agentStates)
  return (
    <Card className="border border-border bg-surface shadow-none">
      <Card.Content className="grid gap-3 p-5">
        <div className="mb-1 flex items-center justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="font-medium text-foreground">
              {state === 'cancelling' ? t('progress.cancellingTitle') : t('progress.runningTitle')}
            </p>
            <p className="mt-1 text-sm text-muted">
              {t('progress.backgroundHint')}
            </p>
          </div>
          <Button
            className="gap-2"
            isDisabled={state === 'cancelling'}
            onPress={onCancel}
            size="sm"
            variant="ghost"
          >
            {state === 'cancelling'
              ? <Spinner aria-label={t('progress.cancellingTitle')} color="current" size="sm" />
              : null}
            {state === 'cancelling' ? t('progress.cancelling') : t('progress.stop')}
          </Button>
        </div>
        {visibleStates.map((state) => (
          <div className="flex items-center justify-between gap-4" key={state.agent}>
            <span className="capitalize text-foreground">{state.agent}</span>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted">{phaseLabel(state)}</span>
              {(state.phase === 'discovering' || state.phase === 'processing') && (
                <Spinner aria-label={t('progress.agentLabel', { agent: state.agent })} color="accent" size="sm" />
              )}
            </div>
          </div>
        ))}
      </Card.Content>
    </Card>
  )
}

function createWaitingStates(selectedAgents: AgentName[]): Record<AgentName, AgentState> {
  return Object.fromEntries(
    selectedAgents.map((agent) => [agent, { agent, phase: 'waiting' }]),
  ) as Record<AgentName, AgentState>
}

function isScanProgress(value: unknown): value is ScanProgress {
  if (!value || typeof value !== 'object') return false
  const progress = value as Partial<ScanProgress>
  return agents.includes(progress.agent as AgentName) && isScanPhase(progress.phase)
}

function scanEventRunId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const runId = (value as { runId?: unknown }).runId
  return typeof runId === 'string' ? runId : undefined
}

function isScanPhase(value: unknown): value is ScanPhase {
  return ['discovering', 'processing', 'done', 'skipped', 'error'].includes(String(value))
}

function isScanSummary(value: unknown): value is ScanSummary {
  if (!value || typeof value !== 'object') return false
  const summary = value as Partial<ScanSummary>
  const numeric = ['total', 'new', 'updated', 'unchanged', 'missing', 'errors'].every(
    (key) => typeof summary[key as keyof ScanSummary] === 'number',
  )
  return numeric && typeof summary.changes === 'object' && summary.changes !== null
}

function phaseLabel(state: AgentState): string {
  if (state.phase === 'waiting') return i18n.t('scan:phase.waiting')
  if (state.phase === 'processing') {
    return state.current === undefined || state.total === undefined
      ? i18n.t('scan:phase.processing')
      : `${state.current}/${state.total}`
  }
  return i18n.t(`scan:phase.${state.phase}`, { defaultValue: state.phase })
}

function formatCompletedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date, currentLocale())
}

function parseScanDays(value: string): number | undefined {
  const days = Number(value)
  return Number.isInteger(days) && days > 0 ? days : undefined
}

function formatScanScope(scope: ScanScope): string {
  return scope.mode === 'recent'
    ? i18n.t('scan:scope.recent', { days: scope.days })
    : i18n.t('scan:scope.full')
}

function isMissingScanHistoryHandler(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.includes("No handler registered for 'scan.history'")
}
