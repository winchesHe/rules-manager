import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  ListBox,
  Select,
  Spinner,
  Switch,
  Table,
} from '@heroui/react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  Asterisk,
  ArrowDown,
  ArrowLeft,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  FilePenLine,
  FileOutput,
  Search,
  SearchCheck,
  Save,
  Sigma,
  Sparkles,
  Square,
  Terminal,
  X,
} from 'lucide-react'
import { afterNextPaint } from '../async'
import { PageHeader } from '../components/PageHeader'
import { PageSection } from '../components/PageSection'
import { PageShell } from '../components/PageShell'
import { SupportingPaneLayout } from '../components/SupportingPaneLayout'
import { EmptyRules, ViewError, ViewLoading } from '../components/ViewStates'
import { currentLocale, i18n } from '../i18n'
import {
  formatBytes as formatLocalizedBytes,
  formatDateTime,
} from '../i18n/format'
import type {
  GenerateProgress,
  AgentInstructionPublishSummary,
  AutoMemoryListResult,
  AutoMemoryReadResult,
  AutoMemorySource,
  ClaudeProjectMemoryPublishResult,
  ClaudeProjectMemoryPublishTarget,
  CodexProjectMemoryPublishResult,
  CodexProjectMemoryPublishTarget,
  GenerationEventEnvelope,
  GenerationHistoryEntry,
  GenerationMode,
  GenerationRequest,
  GenerationStartResult,
  GenerationStatus,
  GlobalInstructionAgent,
  GlobalInstructionListResult,
  GlobalInstructionReadResult,
  Project,
  ProjectGenerationCandidate,
  LlmConfig,
  ProviderId,
  ProviderSnapshot,
  RunCancelResult,
  RuleCandidate,
  RuleStatus,
  SessionEvidenceContext,
  SessionPreview,
} from '../types'
import {
  filterCandidatesByRun,
  parseCandidateEvidence,
  selectableGenerationRuns,
  type CandidateEvidence,
  type EvidenceReference,
} from './rules-view-model'

type RulesPage =
  | 'overview'
  | 'agent'
  | 'memory'
  | 'generate'
  | 'run'
  | 'review'
  | 'output'
export type RulesSection = 'overview' | 'agents' | 'memories' | 'generated'
const NO_SELECTION_KEY = '__none__'
type GenerateMode = GenerationMode
type GenerationPhaseKey = 'evidence' | 'generate' | 'validate' | 'save'

const generationRunMemory = new Map<string, {
  phase: GenerationPhaseKey
  scrollTop: number
}>()

const statuses: Array<{ labelKey: string; value: RuleStatus }> = [
  { labelKey: 'status.draft', value: 'draft' },
  { labelKey: 'status.accepted', value: 'accepted' },
  { labelKey: 'status.rejected', value: 'rejected' },
]

const generationModes: Array<{
  value: GenerateMode
  labelKey: string
  descriptionKey: string
}> = [
  {
    value: 'changed7d',
    labelKey: 'generate.modes.recent.label',
    descriptionKey: 'generate.modes.recent.description',
  },
  {
    value: 'projects',
    labelKey: 'generate.modes.projects.label',
    descriptionKey: 'generate.modes.projects.description',
  },
  {
    value: 'full',
    labelKey: 'generate.modes.full.label',
    descriptionKey: 'generate.modes.full.description',
  },
]

const generationProviders: Array<{ id: ProviderId; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
]

const generationEfforts: LlmConfig['effort'][] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

const DEFAULT_MODEL_KEY = '__provider_default__'

function tr(
  key: string,
  options?: Record<string, string | number | undefined>,
): string {
  return i18n.t(`rules:${key}`, options)
}

export function RulesView({
  initialProjectSlug,
  onInitialProjectHandled,
  initialPublishProjectSlug,
  onInitialPublishProjectHandled,
  initialRunId,
  onInitialRunHandled,
  onOpenChat,
  onOpenProjectRules,
  onSectionChange,
  section,
}: {
  initialProjectSlug?: string | null
  onInitialProjectHandled?: () => void
  initialPublishProjectSlug?: string | null
  onInitialPublishProjectHandled?: () => void
  initialRunId?: string | null
  onInitialRunHandled?: () => void
  onOpenChat: (threadId: string) => void
  onOpenProjectRules?: (slug?: string) => void
  onSectionChange: (section: RulesSection) => void
  section: RulesSection
}) {
  useTranslation('rules')
  const [page, setPage] = useState<RulesPage>('overview')
  const [status, setStatus] = useState<RuleStatus>('draft')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<RuleCandidate[]>([])
  const [generationHistory, setGenerationHistory] =
    useState<GenerationHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [selectedCandidate, setSelectedCandidate] = useState<RuleCandidate | null>(null)
  const [outputProjectSlug, setOutputProjectSlug] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<RuleStatus | null>(null)
  const [pendingBatchAction, setPendingBatchAction] =
    useState<'accepted' | 'rejected' | null>(null)
  const [pendingEdit, setPendingEdit] = useState(false)
  const [generation, setGeneration] = useState<GenerationStatus | null>(null)
  const [selectedInstructionAgent, setSelectedInstructionAgent] =
    useState<GlobalInstructionAgent | null>(null)
  const [selectedMemory, setSelectedMemory] =
    useState<AutoMemorySource | null>(null)
  const [queueRefresh, setQueueRefresh] = useState(0)
  const mounted = useRef(true)
  const previousSection = useRef(section)

  useEffect(() => {
    if (previousSection.current === section) return
    previousSection.current = section
    setPage('overview')
    setSelectedCandidate(null)
    setSelectedInstructionAgent(null)
    setSelectedMemory(null)
    setActionError(null)
    if (section === 'overview') setStatus('draft')
    if (section === 'generated' && !initialRunId) setSelectedRunId(null)
  }, [initialRunId, section])

  useEffect(() => {
    mounted.current = true
    const onProgress = (value: unknown) => {
      if (!isGenerateProgress(value)) return
      const metadata = eventMetadata(value)
      setGeneration((current) => mergeGenerationProgress(current, value, metadata))
      setActionError(null)
    }
    const onEvent = (value: unknown) => {
      if (!isGenerationEventEnvelope(value)) return
      setGeneration((current) => mergeGenerationEvent(current, value))
      setActionError(null)
    }
    const onDone = (value: unknown) => {
      if (!isGenerateProgress(value) || value.phase !== 'done') return
      const metadata = eventMetadata(value)
      setGeneration((current) => {
        const generation = ensureGeneration(current, metadata)
        return {
          ...generation,
          running: false,
          state: 'completed',
          progress: value,
          lastSeq: Math.max(generation.lastSeq, metadata.seq ?? 0),
          endedAt: metadata.at ?? new Date().toISOString(),
        }
      })
      setQueueRefresh((current) => current + 1)
    }
    const onCancelled = (value: unknown) => {
      const metadata = eventMetadata(value)
      setGeneration((current) => {
        const generation = ensureGeneration(current, metadata)
        return {
          ...generation,
          running: false,
          state: 'cancelled',
          lastSeq: Math.max(generation.lastSeq, metadata.seq ?? 0),
          endedAt: metadata.at ?? new Date().toISOString(),
          error: undefined,
        }
      })
    }
    const onFailed = (value: unknown) => {
      setActionError(failureMessage(value))
      const metadata = eventMetadata(value)
      setGeneration((current) => {
        const generation = ensureGeneration(current, metadata)
        return {
          ...generation,
          running: false,
          state: 'failed',
          lastSeq: Math.max(generation.lastSeq, metadata.seq ?? 0),
          endedAt: metadata.at ?? new Date().toISOString(),
          error: failureMessage(value),
        }
      })
    }
    window.api.onEvent('generate.progress', onProgress)
    window.api.onEvent('generate.event', onEvent)
    window.api.onEvent('generate.done', onDone)
    window.api.onEvent('generate.cancelled', onCancelled)
    window.api.onEvent('generate.failed', onFailed)
    void afterNextPaint(() =>
      window.api.invoke<GenerationStatus>('rules.generate.status'),
    )
      .then((status) => {
        if (!mounted.current) return
        setGeneration((current) =>
          current && current.lastSeq > status.lastSeq ? current : status,
        )
        if (status.error) setActionError(status.error)
      })
      .catch((reason: unknown) => {
        if (mounted.current) {
          setActionError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      mounted.current = false
      window.api.offEvent('generate.progress', onProgress)
      window.api.offEvent('generate.event', onEvent)
      window.api.offEvent('generate.done', onDone)
      window.api.offEvent('generate.cancelled', onCancelled)
      window.api.offEvent('generate.failed', onFailed)
    }
  }, [])

  useEffect(() => {
    if (!initialProjectSlug) return
    setPage('generate')
    onInitialProjectHandled?.()
  }, [initialProjectSlug, onInitialProjectHandled])

  useEffect(() => {
    if (!initialPublishProjectSlug) return
    setOutputProjectSlug(initialPublishProjectSlug)
    setPage('output')
    onInitialPublishProjectHandled?.()
  }, [initialPublishProjectSlug, onInitialPublishProjectHandled])

  useEffect(() => {
    if (!initialRunId) return
    setSelectedRunId(initialRunId)
    setStatus('draft')
    onInitialRunHandled?.()
  }, [initialRunId, onInitialRunHandled])

  useEffect(() => {
    let current = true
    setHistoryLoading(true)
    setHistoryError(null)
    void afterNextPaint(() =>
      window.api.invoke<GenerationHistoryEntry[]>('rules.generate.history'),
    )
      .then((rows) => {
        if (current) setGenerationHistory(rows)
      })
      .catch((reason: unknown) => {
        if (current) {
          setHistoryError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (current) setHistoryLoading(false)
      })
    return () => {
      current = false
    }
  }, [queueRefresh])

  useEffect(() => {
    if (page !== 'overview') return
    let current = true
    setLoading(true)
    setError(null)
    setActionError(null)
    void afterNextPaint(() => window.api.invoke<RuleCandidate[]>('rules.candidates', status))
      .then((rows) => {
        if (current) setCandidates(rows)
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [page, queueRefresh, status])

  function openReview(candidate: RuleCandidate): void {
    setSelectedCandidate(candidate)
    setPage('review')
  }

  async function updateStatus(nextStatus: 'accepted' | 'rejected'): Promise<void> {
    if (!selectedCandidate || pendingAction) return
    setPendingAction(nextStatus)
    setActionError(null)
    try {
      await afterNextPaint(() =>
        window.api.invoke<RuleCandidate>(
          'rules.updateStatus',
          selectedCandidate.id,
          nextStatus,
        ),
      )
      if (mounted.current) {
        setSelectedCandidate(null)
        setStatus('draft')
        setPage('overview')
      }
    } catch (reason: unknown) {
      if (mounted.current) {
        setActionError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (mounted.current) setPendingAction(null)
    }
  }

  async function updateStatuses(
    ids: string[],
    nextStatus: 'accepted' | 'rejected',
  ): Promise<boolean> {
    if (ids.length === 0 || pendingBatchAction) return false
    setPendingBatchAction(nextStatus)
    setActionError(null)
    try {
      await afterNextPaint(() =>
        window.api.invoke<RuleCandidate[]>(
          'rules.batchUpdateStatus',
          ids,
          nextStatus,
        ),
      )
      if (mounted.current) setQueueRefresh((current) => current + 1)
      return true
    } catch (reason: unknown) {
      if (mounted.current) {
        setActionError(reason instanceof Error ? reason.message : String(reason))
      }
      return false
    } finally {
      if (mounted.current) setPendingBatchAction(null)
    }
  }

  async function cancelGeneration(): Promise<void> {
    if (!generation?.runId || generation.state !== 'running') return
    setActionError(null)
    setGeneration((current) => current
      ? { ...current, running: true, state: 'cancelling' }
      : current)
    try {
      const result = await window.api.invoke<RunCancelResult>(
        'rules.generate.cancel',
        { runId: generation.runId },
      )
      if (!result.accepted && 'reason' in result && result.reason !== 'already-cancelling') {
        const status = await window.api.invoke<GenerationStatus>('rules.generate.status')
        setGeneration(status)
      }
    } catch (reason: unknown) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
      const status = await window.api.invoke<GenerationStatus>('rules.generate.status')
      setGeneration(status)
    }
  }

  async function updateCandidateText(ruleText: string): Promise<void> {
    if (!selectedCandidate || pendingEdit) return
    setPendingEdit(true)
    setActionError(null)
    try {
      const updated = await afterNextPaint(() =>
        window.api.invoke<RuleCandidate>(
          'rules.updateText',
          selectedCandidate.id,
          ruleText,
        ),
      )
      setSelectedCandidate(updated)
      setQueueRefresh((current) => current + 1)
    } catch (reason: unknown) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPendingEdit(false)
    }
  }

  if (page === 'generate') {
    return (
      <GenerateRulesPage
        error={actionError}
        initialProjectSlug={initialProjectSlug}
        onBack={() => setPage('overview')}
        onError={setActionError}
        onStarted={onOpenChat}
      />
    )
  }
  if (page === 'run' && generation?.runId) {
    return (
      <GenerationRunPage
        error={actionError}
        generation={generation}
        onBack={() => setPage('overview')}
        onCancel={() => void cancelGeneration()}
        onReview={() => {
          setStatus('draft')
          setSelectedRunId(generation.runId ?? null)
          onSectionChange('generated')
          setPage('overview')
        }}
      />
    )
  }
  if (page === 'review' && selectedCandidate) {
    return (
      <ReviewRulePage
        candidate={selectedCandidate}
        error={actionError}
        onBack={() => {
          setSelectedCandidate(null)
          setPage('overview')
        }}
        onUpdate={(nextStatus) => void updateStatus(nextStatus)}
        pendingAction={pendingAction}
        pendingEdit={pendingEdit}
        onEdit={(ruleText) => void updateCandidateText(ruleText)}
      />
    )
  }
  if (page === 'output') {
    return (
      <OutputRulesPage
        initialProjectSlug={outputProjectSlug}
        onBack={() => {
          setOutputProjectSlug(null)
          onSectionChange('generated')
          setPage('overview')
        }}
      />
    )
  }
  if (page === 'agent' && selectedInstructionAgent) {
    return (
      <AgentInstructionDetailPage
        agent={selectedInstructionAgent}
        onBack={() => {
          setSelectedInstructionAgent(null)
          setPage('overview')
        }}
      />
    )
  }
  if (page === 'memory' && selectedMemory) {
    return (
      <AgentMemoryDetailPage
        source={selectedMemory}
        onBack={() => {
          setSelectedMemory(null)
          setPage('overview')
        }}
      />
    )
  }

  return (
    <RulesOverviewPage
      actionError={actionError}
      candidates={candidates}
      error={error}
      generation={generation}
      generationHistory={generationHistory}
      historyError={historyError}
      historyLoading={historyLoading}
      loading={loading}
      onGenerate={() => {
        setActionError(null)
        if (isActiveGeneration(generation) && generation?.runId) {
          onOpenChat(generation.runId)
        } else {
          setPage('generate')
        }
      }}
      onOpenAgent={(agent) => {
        setSelectedInstructionAgent(agent)
        setPage('agent')
      }}
      onOpenMemory={(source) => {
        setSelectedMemory(source)
        setPage('memory')
      }}
      onOpenOutput={() => setPage('output')}
      onOpenProjectRules={onOpenProjectRules}
      onOpenHistory={(entry) => {
        onOpenChat(entry.id)
      }}
      onOpenRun={() => {
        if (generation?.runId) onOpenChat(generation.runId)
      }}
      onBatchUpdate={updateStatuses}
      onReview={openReview}
      onRunChange={setSelectedRunId}
      onSectionChange={onSectionChange}
      onStatusChange={setStatus}
      pendingBatchAction={pendingBatchAction}
      section={section}
      selectedRunId={selectedRunId}
      status={status}
    />
  )
}

function RulesOverviewPage({
  actionError,
  candidates,
  error,
  generation,
  generationHistory,
  historyError,
  historyLoading,
  loading,
  onGenerate,
  onBatchUpdate,
  onOpenAgent,
  onOpenMemory,
  onOpenOutput,
  onOpenHistory,
  onOpenProjectRules,
  onOpenRun,
  onReview,
  onRunChange,
  onSectionChange,
  onStatusChange,
  pendingBatchAction,
  section,
  selectedRunId,
  status,
}: {
  actionError: string | null
  candidates: RuleCandidate[]
  error: string | null
  generation: GenerationStatus | null
  generationHistory: GenerationHistoryEntry[]
  historyError: string | null
  historyLoading: boolean
  loading: boolean
  onGenerate: () => void
  onBatchUpdate: (
    ids: string[],
    status: 'accepted' | 'rejected',
  ) => Promise<boolean>
  onOpenAgent: (agent: GlobalInstructionAgent) => void
  onOpenMemory: (source: AutoMemorySource) => void
  onOpenOutput: () => void
  onOpenHistory: (entry: GenerationHistoryEntry) => void
  onOpenProjectRules?: (slug?: string) => void
  onOpenRun: () => void
  onReview: (candidate: RuleCandidate) => void
  onRunChange: (runId: string | null) => void
  onSectionChange: (section: RulesSection) => void
  onStatusChange: (status: RuleStatus) => void
  pendingBatchAction: 'accepted' | 'rejected' | null
  section: RulesSection
  selectedRunId: string | null
  status: RuleStatus
}) {
  const [sources, setSources] = useState<GlobalInstructionReadResult[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewError, setOverviewError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void afterNextPaint(() =>
      Promise.all([
        window.api.invoke<GlobalInstructionListResult>('rules.instructions.list'),
        window.api.invoke<Project[]>('projects.list'),
      ]),
    )
      .then(async ([instructionResult, projectRows]) => {
        const instructionRows = await Promise.all(
          instructionResult.sources.map((source) =>
            window.api.invoke<GlobalInstructionReadResult>(
              'rules.instructions.read',
              source.agent,
            ),
          ),
        )
        if (!current) return
        setSources(instructionRows)
        setProjects(projectRows)
      })
      .catch((reason: unknown) => {
        if (current) {
          setOverviewError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (current) setOverviewLoading(false)
      })
    return () => {
      current = false
    }
  }, [])

  if (section === 'agents') {
    return (
      <AgentInstructionsIndexPage
        actionError={actionError ?? overviewError}
        loading={overviewLoading}
        onOpenAgent={onOpenAgent}
        sources={sources}
      />
    )
  }

  if (section === 'memories') {
    return <AgentMemoryIndexPage onOpenMemory={onOpenMemory} />
  }

  if (section === 'generated') {
    return (
      <GeneratedRulesIndexPage
        actionError={actionError}
        candidates={candidates}
        error={error}
        history={generationHistory}
        historyError={historyError}
        historyLoading={historyLoading}
        loading={loading}
        onBatchUpdate={onBatchUpdate}
        onOpenHistory={onOpenHistory}
        onOpenOutput={onOpenOutput}
        onReview={onReview}
        onRunChange={onRunChange}
        onStatusChange={onStatusChange}
        pendingBatchAction={pendingBatchAction}
        selectedRunId={selectedRunId}
        status={status}
      />
    )
  }

  if (section === 'overview') {
    return (
      <RulesDashboardPage
        actionError={actionError ?? overviewError}
        candidates={candidates}
        generation={generation}
        history={generationHistory}
        loading={loading || overviewLoading || historyLoading}
        onGenerate={onGenerate}
        onOpenAgent={onOpenAgent}
        onOpenHistory={onOpenHistory}
        onOpenProjectRules={onOpenProjectRules}
        onOpenRun={onOpenRun}
        onReview={onReview}
        onSectionChange={onSectionChange}
        projects={projects}
        sources={sources}
      />
    )
  }

  return (
    <>
      <PageHeader
        actions={
          <Button
            className="gap-2 bg-primary text-primary-foreground"
            onPress={onGenerate}
          >
            {isActiveGeneration(generation)
              ? <Activity aria-hidden="true" size={17} />
              : <Sparkles aria-hidden="true" size={17} />}
            {isActiveGeneration(generation) ? tr('actions.viewGeneration') : tr('actions.startGenerate')}
          </Button>
        }
        description={tr('description')}
        title={tr('title')}
      />

      {status === 'draft' && candidates.length > 0 && (
        <button
          className="mb-4 grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl border border-primary/40 bg-primary-soft px-5 py-4 text-left transition-colors hover:bg-surface-hover max-sm:grid-cols-1"
          onClick={() => onReview(candidates[0])}
          type="button"
        >
          <span>
            <strong className="block text-sm text-foreground">
              {tr('overview.generatedNeedsReview', { count: candidates.length })}
            </strong>
            <span className="mt-1 block text-sm text-muted">
              {tr('overview.notPublished')}
            </span>
          </span>
          <span className="flex items-center gap-2 text-sm text-foreground">
            {tr('actions.reviewDrafts')}
            <ChevronRight aria-hidden="true" size={17} />
          </span>
        </button>
      )}

      {(actionError || overviewError) && (
        <div className="mb-4">
          <ErrorAlert
            message={actionError ?? overviewError ?? ''}
            title={tr('errors.overview')}
          />
        </div>
      )}

      <Card className="border border-border bg-surface shadow-none">
        <Card.Header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="font-medium text-foreground">{tr('overview.agentInstructions')}</h2>
            <p className="mt-1 text-sm text-muted">
              {tr('overview.agentDescription')}
            </p>
          </div>
          <Chip size="sm" variant="soft">{tr('overview.agentsCount')}</Chip>
        </Card.Header>
        <Card.Content className="p-0">
          {overviewLoading ? (
            <ViewLoading label={tr('instructions.loading')} />
          ) : (
            <div aria-label={tr('instructions.listLabel')}>
              {sources.map((source) => (
                <button
                  className="grid w-full cursor-pointer grid-cols-[2.5rem_minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border px-5 py-3.5 text-left transition-colors last:border-b-0 hover:bg-surface-hover max-sm:grid-cols-[2.5rem_minmax(0,1fr)_auto]"
                  key={source.source.agent}
                  onClick={() => onOpenAgent(source.source.agent)}
                  type="button"
                >
                  <AgentMark agent={source.source.agent} />
                  <span className="min-w-0">
                    <strong className="block text-sm font-medium text-foreground">
                      {instructionAgentLabel(source.source.agent)}
                    </strong>
                    <code className="mt-1 block truncate text-xs text-muted">
                      {source.source.path}
                    </code>
                  </span>
                  <span className="text-right max-sm:hidden">
                    <strong className="block text-sm font-normal text-foreground">
                      {source.source.status === 'present'
                        ? `${formatInstructionSize(source.sizeBytes)} · ${formatInstructionModified(source.modifiedAt)}`
                        : tr('status.fileNotFound')}
                    </strong>
                    <span className="mt-1 block text-xs text-muted">
                      {source.source.status === 'present' ? tr('status.globalFile') : tr('status.createOnSave')}
                    </span>
                  </span>
                  <span className="flex items-center gap-1 text-sm text-foreground">
                    {source.source.status === 'present' ? tr('actions.view') : tr('actions.setup')}
                    <ChevronRight aria-hidden="true" size={16} />
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card.Content>
      </Card>

      <div className="mt-4 grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        <Card className="border border-border bg-surface shadow-none">
          <Card.Header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h2 className="font-medium text-foreground">{tr('overview.projectRules')}</h2>
              <p className="mt-1 text-sm text-muted">{tr('overview.projectDescription')}</p>
            </div>
            <Button onPress={() => onOpenProjectRules?.()} size="sm" variant="ghost">
              {tr('actions.viewAll')}
            </Button>
          </Card.Header>
          <Card.Content className="p-0">
            {projects.slice(0, 3).map((project) => (
              <button
                className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-5 py-3.5 text-left transition-colors last:border-b-0 hover:bg-surface-hover"
                key={project.slug}
                onClick={() => onOpenProjectRules?.(project.slug)}
                type="button"
              >
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-medium text-foreground">
                    {project.slug}
                  </strong>
                  <span className="mt-1 block text-xs text-muted">
                    {tr('overview.projectSessions', { count: project.sessionCount })}
                  </span>
                </span>
                <ChevronRight aria-hidden="true" className="text-muted" size={17} />
              </button>
            ))}
            {!overviewLoading && projects.length === 0 && (
              <div className="px-5 py-8 text-center text-sm text-muted">{tr('overview.noProjects')}</div>
            )}
          </Card.Content>
        </Card>

        <Card className="border border-border bg-surface shadow-none">
          <Card.Header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h2 className="font-medium text-foreground">{tr('overview.recentGenerations')}</h2>
              <p className="mt-1 text-sm text-muted">{tr('overview.recentDescription')}</p>
            </div>
            <Button className="gap-2" onPress={onOpenOutput} size="sm" variant="ghost">
              <FileOutput aria-hidden="true" size={16} />
              {tr('actions.publish')}
            </Button>
          </Card.Header>
          <Card.Content className="p-0">
            {generationHistory.length > 0 ? (
              generationHistory.slice(0, 4).map((entry) => {
                const isCurrent = entry.id === generation?.runId
                return (
                  <button
                    className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-5 py-3.5 text-left transition-colors last:border-b-0 hover:bg-surface-hover"
                    key={entry.id}
                    onClick={() => {
                      if (isCurrent && generation?.runId) onOpenRun()
                      else onOpenHistory(entry)
                    }}
                    type="button"
                  >
                    <span className="min-w-0">
                      <strong className="flex items-center gap-2 text-sm font-medium text-foreground">
                        {isCurrent && isActiveGeneration(generation) && <Spinner color="accent" size="sm" />}
                        {generationHistoryScopeLabel(entry)}
                      </strong>
                      <span className="mt-1 block truncate text-xs text-muted">
                        {entry.evidence
                          ? tr('overview.runSummary', {
                              projects: entry.evidence.projectCount,
                              sessions: entry.evidence.totalSessions,
                              drafts: entry.candidateCount,
                            })
                          : tr('overview.legacyRunSummary', {
                              drafts: entry.candidateCount,
                              time: formatDateTime(entry.startedAt, currentLocale()),
                            })}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Chip color={generationStateColor(entry.status)} size="sm" variant="soft">
                        {tr(`runTitle.${entry.status}`, { defaultValue: entry.status })}
                      </Chip>
                      <ChevronRight aria-hidden="true" size={17} />
                    </span>
                  </button>
                )
              })
            ) : (
              <div className="px-5 py-8 text-center text-sm text-muted">
                {tr('overview.noSessionRuns')}
              </div>
            )}
          </Card.Content>
        </Card>
      </div>

      <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-medium text-foreground">{tr('overview.generatedRules')}</h2>
          <p className="mt-1 text-sm text-muted">{tr('overview.generatedDescription')}</p>
        </div>
        <div aria-label={tr('overview.ruleStatusLabel')} className="flex flex-wrap gap-2">
          {statuses.map((item) => (
            <Button
              aria-pressed={status === item.value}
              key={item.value}
              onPress={() => onStatusChange(item.value)}
              size="sm"
              variant={status === item.value ? 'primary' : 'ghost'}
            >
              {tr(item.labelKey)}
            </Button>
          ))}
        </div>
      </div>
      <Card className="min-h-64 border border-border bg-surface shadow-none">
        <Card.Content className="p-0">
          {loading ? (
            <ViewLoading label={tr('overview.loadingRules', { status: tr(`status.${status}`) })} />
          ) : error ? (
            <div className="p-6">
              <ViewError message={error} title={tr('errors.generated')} />
            </div>
          ) : candidates.length === 0 ? (
            <EmptyRules />
          ) : (
            <Table className="rounded-none bg-transparent shadow-none">
              <Table.ScrollContainer>
                <Table.Content aria-label={tr('overview.tableLabel', { status: tr(`status.${status}`) })}>
                  <Table.Header>
                    <Table.Column isRowHeader>{tr('overview.columns.rule')}</Table.Column>
                    <Table.Column>{tr('overview.columns.scope')}</Table.Column>
                    <Table.Column>{tr('overview.columns.confidence')}</Table.Column>
                    <Table.Column>{tr('overview.columns.actions')}</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {candidates.slice(0, 6).map((candidate) => (
                      <Table.Row id={candidate.id} key={candidate.id}>
                        <Table.Cell className="max-w-xl">
                          <p className="line-clamp-2">{candidate.rule_text}</p>
                        </Table.Cell>
                        <Table.Cell className="text-muted">
                          {candidate.project_slug ?? candidate.scope}
                        </Table.Cell>
                        <Table.Cell>
                          <ConfidenceChip level={candidate.confidence_level} />
                        </Table.Cell>
                        <Table.Cell>
                          <Button
                            className="gap-2"
                            onPress={() => onReview(candidate)}
                            size="sm"
                            variant="ghost"
                          >
                            <SearchCheck aria-hidden="true" size={16} />
                            {tr('actions.review')}
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
    </>
  )
}

function RulesDashboardPage({
  actionError,
  candidates,
  generation,
  history,
  loading,
  onGenerate,
  onOpenAgent,
  onOpenHistory,
  onOpenProjectRules,
  onOpenRun,
  onReview,
  onSectionChange,
  projects,
  sources,
}: {
  actionError: string | null
  candidates: RuleCandidate[]
  generation: GenerationStatus | null
  history: GenerationHistoryEntry[]
  loading: boolean
  onGenerate: () => void
  onOpenAgent: (agent: GlobalInstructionAgent) => void
  onOpenHistory: (entry: GenerationHistoryEntry) => void
  onOpenProjectRules?: (slug?: string) => void
  onOpenRun: () => void
  onReview: (candidate: RuleCandidate) => void
  onSectionChange: (section: RulesSection) => void
  projects: Project[]
  sources: GlobalInstructionReadResult[]
}) {
  const configured = sources.filter((source) => source.source.status === 'present')
  const missing = sources.find((source) => source.source.status !== 'present')
  const latest = history[0]
  const acceptedCount = candidates.filter((candidate) => candidate.status === 'accepted').length
  const supportingPane = (
    <div
      className="overflow-hidden rounded-xl border border-border bg-surface"
      data-dashboard-status-pane="true"
    >
      <section className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">{tr('dashboard.instructionHealth')}</h2>
          <Button onPress={() => onSectionChange('agents')} size="sm" variant="ghost">{tr('actions.manage')}</Button>
        </div>
        <div className="border-t border-border">
          <button
            className="flex w-full items-center justify-between gap-3 border-b border-border py-3 text-left"
            onClick={() => onSectionChange('agents')}
            type="button"
          >
            <strong className="text-xs font-medium text-foreground">
              {configured.map((source) => instructionAgentLabel(source.source.agent)).join(' · ') || tr('dashboard.noAgents')}
            </strong>
            <span className="text-xs text-success">{tr('status.ready')}</span>
          </button>
          {missing && (
            <button
              className="flex w-full items-center justify-between gap-3 border-b border-border py-3 text-left"
              onClick={() => onOpenAgent(missing.source.agent)}
              type="button"
            >
              <strong className="text-xs font-medium text-foreground">{instructionAgentLabel(missing.source.agent)}</strong>
              <span className="text-xs text-warning">{tr('status.setupRequired')}</span>
            </button>
          )}
        </div>
      </section>
      <section className="border-t border-border p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">{tr('dashboard.latestGeneration')}</h2>
          <Button onPress={() => onSectionChange('history')} size="sm" variant="ghost">{tr('actions.history')}</Button>
        </div>
        {latest ? (
          <button
            className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-y border-border py-3 text-left"
            onClick={() => {
              if (latest.id === generation?.runId && generation?.runId) onOpenRun()
              else onOpenHistory(latest)
            }}
            type="button"
          >
            <span className="min-w-0">
              <strong className="block truncate text-xs font-medium text-foreground">{generationHistoryScopeLabel(latest)}</strong>
              <span className="mt-1 block text-xs text-muted">
                {latest.evidence
                  ? tr('dashboard.latestSummary', {
                      projects: latest.evidence.projectCount,
                      sessions: latest.evidence.totalSessions,
                    })
                  : tr('dashboard.candidateSummary', { count: latest.candidateCount })}
              </span>
            </span>
            <Chip color={generationStateColor(latest.status)} size="sm" variant="soft">{generationRunTitle(latest.status)}</Chip>
          </button>
        ) : (
          <p className="border-y border-border py-4 text-xs text-muted">{tr('dashboard.noGenerations')}</p>
        )}
      </section>
      <section className="border-t border-border p-5">
        <strong className="block text-sm font-medium text-foreground">{tr('dashboard.projectRulesTitle')}</strong>
        <span className="mt-1 block text-xs text-muted">
          {tr('dashboard.projectsAvailable', { count: projects.length })}
        </span>
        <Button
          className="mt-3 w-full justify-between"
          onPress={() => onOpenProjectRules?.()}
          size="sm"
          variant="ghost"
        >
          {tr('actions.openProjects')}
        </Button>
      </section>
    </div>
  )
  return (
    <PageShell archetype="dashboard" density="compact" width="wide">
      <PageHeader
        actions={
          <Button className="gap-2 bg-primary text-primary-foreground" onPress={onGenerate}>
            {isActiveGeneration(generation)
              ? <Activity aria-hidden="true" size={17} />
              : <Sparkles aria-hidden="true" size={17} />}
            {isActiveGeneration(generation) ? tr('actions.viewGeneration') : tr('actions.startGenerate')}
          </Button>
        }
        className="mb-0"
        description={tr('overview.description')}
        title={tr('title')}
      />
      {actionError && <div className="mb-4"><ErrorAlert message={actionError} title={tr('errors.overview')} /></div>}
      {loading ? (
        <ViewLoading label={tr('errors.overview')} />
      ) : (
        <SupportingPaneLayout
          pane={supportingPane}
          paneLabel={tr('dashboard.instructionHealth')}
          paneWidth="md"
        >
          <PageSection
            action={(
              <Button onPress={() => onSectionChange('generated')} size="sm" variant="ghost">
                {tr('actions.openGenerated')}
              </Button>
            )}
            description={tr('dashboard.attentionDescription')}
            title={tr('dashboard.attention')}
          >
            <div
              className="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-surface"
              data-dashboard-summary="true"
            >
              <div className="bg-primary-soft px-5 py-4">
                <span className="block text-xs font-medium text-primary">{tr('dashboard.metrics.needsReview')}</span>
                <strong className="mt-2 block text-3xl font-semibold text-foreground">{candidates.length}</strong>
                <span className="mt-1 block text-xs text-muted">{tr('dashboard.metrics.draftRules')}</span>
              </div>
              <div className="border-l border-border px-5 py-4">
                <span className="block text-xs font-medium text-muted">{tr('dashboard.metrics.accepted')}</span>
                <strong className="mt-2 block text-3xl font-semibold text-foreground">{acceptedCount}</strong>
                <span className="mt-1 block text-xs text-muted">{tr('dashboard.metrics.readyPublish')}</span>
              </div>
            </div>
            <div className="mt-4 border-t border-border">
              {candidates.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted">{tr('dashboard.emptyReview')}</div>
              ) : (
                candidates.slice(0, 4).map((candidate) => (
                  <button
                    className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-1 py-4 text-left transition-colors hover:bg-surface-hover"
                    key={candidate.id}
                    onClick={() => onReview(candidate)}
                    type="button"
                  >
                    <span className="min-w-0">
                      <strong className="block truncate text-sm font-medium text-foreground">{candidate.rule_text}</strong>
                      <span className="mt-1 block text-xs text-muted">
                        {candidate.project_slug ?? candidate.scope} · {tr('confidence', { level: candidate.confidence_level })}
                      </span>
                    </span>
                    <Chip color="warning" size="sm" variant="soft">{tr('actions.review')}</Chip>
                  </button>
                ))
              )}
            </div>
          </PageSection>
        </SupportingPaneLayout>
      )}
    </PageShell>
  )
}

function AgentInstructionsIndexPage({
  actionError,
  loading,
  onOpenAgent,
  sources,
}: {
  actionError: string | null
  loading: boolean
  onOpenAgent: (agent: GlobalInstructionAgent) => void
  sources: GlobalInstructionReadResult[]
}) {
  const configured = sources.filter((source) => source.source.status === 'present').length
  return (
    <>
      {actionError && (
        <div className="mb-4">
          <ErrorAlert message={actionError} title={tr('errors.instructions')} />
        </div>
      )}
      <div className="mb-3 flex items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-medium text-foreground">{tr('instructions.files')}</h2>
          <p className="mt-1 text-sm text-muted">{tr('instructions.filesDescription')}</p>
        </div>
        <Chip color={configured === sources.length ? 'success' : 'warning'} size="sm" variant="soft">
          {tr('instructions.configured', { count: configured })}
        </Chip>
      </div>
      {loading ? (
        <ViewLoading label={tr('instructions.loading')} />
      ) : (
        <div aria-label={tr('instructions.listLabel')} className="overflow-hidden border-y border-border">
          {sources.map((source) => (
            <button
              className="grid w-full cursor-pointer grid-cols-[2.5rem_minmax(0,1fr)_auto_auto] items-center gap-4 border-b border-border px-4 py-5 text-left transition-colors last:border-b-0 hover:bg-surface-hover max-sm:grid-cols-[2.5rem_minmax(0,1fr)_auto]"
              key={source.source.agent}
              onClick={() => onOpenAgent(source.source.agent)}
              type="button"
            >
              <AgentMark agent={source.source.agent} />
              <span className="min-w-0">
                <strong className="block text-sm font-semibold text-foreground">
                  {instructionAgentLabel(source.source.agent)}
                </strong>
                <code className="mt-1 block truncate text-xs text-muted">
                  {source.source.path}
                </code>
              </span>
              <span className="text-right max-sm:hidden">
                <strong className="block text-sm font-normal text-foreground">
                  {source.source.status === 'present'
                    ? `${formatInstructionSize(source.sizeBytes)} · ${formatInstructionModified(source.modifiedAt)}`
                    : tr('status.fileNotFound')}
                </strong>
                <span className="mt-1 block text-xs text-muted">
                  {source.source.status === 'present' ? tr('status.globalFile') : tr('status.createOnSave')}
                </span>
              </span>
              <span className="flex items-center gap-1 text-sm text-foreground">
                {source.source.status === 'present' ? tr('actions.view') : tr('actions.setup')}
                <ChevronRight aria-hidden="true" size={16} />
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function AgentMemoryIndexPage({
  onOpenMemory,
}: {
  onOpenMemory: (source: AutoMemorySource) => void
}) {
  const [result, setResult] = useState<AutoMemoryListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let current = true
    setLoading(true)
    setError(null)
    void afterNextPaint(() =>
      window.api.invoke<AutoMemoryListResult>('rules.memories.list'),
    )
      .then((value) => {
        if (current) setResult(value)
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [refresh])

  const presentCount = result?.sources.filter((source) => source.status === 'present').length ?? 0
  const sourceErrors = result?.errors
    .map((item) => `${item.path}: ${item.message}`)
    .join('\n')
  return (
    <>
      {(error || sourceErrors) && (
        <div className="mb-4">
          <ErrorAlert message={error ?? sourceErrors ?? ''} title={tr('memory.errors.list')} />
        </div>
      )}
      <div className="mb-3 flex items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-medium text-foreground">{tr('memory.sources')}</h2>
          <p className="mt-1 text-sm text-muted">{tr('memory.sourcesDescription')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Chip color={presentCount > 0 ? 'success' : 'warning'} size="sm" variant="soft">
            {tr('memory.available', { count: presentCount })}
          </Chip>
          <Button onPress={() => setRefresh((value) => value + 1)} size="sm" variant="ghost">
            {tr('actions.reload')}
          </Button>
        </div>
      </div>
      {loading ? (
        <ViewLoading label={tr('memory.loading')} />
      ) : (
        <div aria-label={tr('memory.listLabel')} className="overflow-hidden border-y border-border">
          {(result?.sources ?? []).map((source) => (
            <button
              className="grid w-full cursor-pointer grid-cols-[2.5rem_minmax(0,1fr)_auto_auto] items-center gap-4 border-b border-border px-4 py-5 text-left transition-colors last:border-b-0 hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent max-sm:grid-cols-[2.5rem_minmax(0,1fr)_auto]"
              disabled={source.status === 'missing'}
              key={`${source.agent}:${source.id}`}
              onClick={() => onOpenMemory(source)}
              type="button"
            >
              <AgentMark agent={source.agent} />
              <span className="min-w-0">
                <strong className="block truncate text-sm font-semibold text-foreground">
                  {autoMemorySourceTitle(source)}
                </strong>
                <code className="mt-1 block truncate text-xs text-muted">{source.path}</code>
              </span>
              <span className="text-right max-sm:hidden">
                <strong className="block text-sm font-normal text-foreground">
                  {source.status === 'present'
                    ? `${formatInstructionSize(source.sizeBytes)} · ${formatInstructionModified(source.modifiedAt)}`
                    : tr('memory.notGenerated')}
                </strong>
                <span className="mt-1 block text-xs text-muted">
                  {source.scope === 'project' ? tr('memory.projectScope') : tr('memory.localScope')}
                </span>
              </span>
              <span className="flex items-center gap-1 text-sm text-foreground">
                {source.status === 'present' ? tr('actions.view') : tr('status.none')}
                {source.status === 'present' && <ChevronRight aria-hidden="true" size={16} />}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-xl border border-border bg-surface px-5 py-4">
        <Brain aria-hidden="true" className="mt-0.5 text-muted" size={18} />
        <div>
          <strong className="text-sm font-medium text-foreground">{tr('memory.boundaryTitle')}</strong>
          <p className="mt-1 text-sm text-muted">{tr('memory.boundaryDescription')}</p>
        </div>
      </div>
    </>
  )
}

function GeneratedRulesIndexPage({
  actionError,
  candidates,
  error,
  history,
  historyError,
  historyLoading,
  loading,
  onBatchUpdate,
  onOpenHistory,
  onOpenOutput,
  onReview,
  onRunChange,
  onStatusChange,
  pendingBatchAction,
  selectedRunId,
  status,
}: {
  actionError: string | null
  candidates: RuleCandidate[]
  error: string | null
  history: GenerationHistoryEntry[]
  historyError: string | null
  historyLoading: boolean
  loading: boolean
  onBatchUpdate: (
    ids: string[],
    status: 'accepted' | 'rejected',
  ) => Promise<boolean>
  onOpenHistory: (entry: GenerationHistoryEntry) => void
  onOpenOutput: () => void
  onReview: (candidate: RuleCandidate) => void
  onRunChange: (runId: string | null) => void
  onStatusChange: (status: RuleStatus) => void
  pendingBatchAction: 'accepted' | 'rejected' | null
  selectedRunId: string | null
  status: RuleStatus
}) {
  const runs = selectableGenerationRuns(history)
  const selectedRun = runs.find((entry) => entry.id === selectedRunId)
  const visibleCandidates = filterCandidatesByRun(candidates, selectedRunId)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const allVisibleSelected = visibleCandidates.length > 0
    && visibleCandidates.every((candidate) => selectedIds.has(candidate.id))
  const someVisibleSelected = visibleCandidates.some((candidate) => selectedIds.has(candidate.id))
  const loadError = actionError ?? error ?? historyError

  useEffect(() => {
    setSelectedIds(new Set())
  }, [selectedRunId, status])

  useEffect(() => {
    const visibleIds = new Set(visibleCandidates.map((candidate) => candidate.id))
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [candidates, selectedRunId])

  function toggleCandidateSelection(candidateId: string): void {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(candidateId)) next.delete(candidateId)
      else next.add(candidateId)
      return next
    })
  }

  async function runBulkUpdate(nextStatus: 'accepted' | 'rejected'): Promise<void> {
    const succeeded = await onBatchUpdate([...selectedIds], nextStatus)
    if (succeeded) setSelectedIds(new Set())
  }
  return (
    <>
      {loadError && (
        <div className="mb-4">
          <ErrorAlert message={loadError} title={tr('errors.generated')} />
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-medium text-foreground">{tr('generated.candidates')}</h2>
          <p className="mt-1 text-sm text-muted">{tr('generated.publishDescription')}</p>
        </div>
        <Button className="gap-2" onPress={onOpenOutput} size="sm" variant="ghost">
          <FileOutput aria-hidden="true" size={16} />
          {tr('generated.publishAccepted')}
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Select
            aria-label={tr('generated.batchLabel')}
            className="w-[min(28rem,100%)]"
            isDisabled={historyLoading}
            onSelectionChange={(key) => {
              const value = String(key)
              onRunChange(value === 'all' ? null : value)
            }}
            selectedKey={selectedRunId ?? 'all'}
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item
                  id="all"
                  textValue={status === 'draft'
                    ? tr('generated.allPending')
                    : tr('generated.allRuns')}
                >
                  {status === 'draft'
                    ? tr('generated.allPending')
                    : tr('generated.allRuns')}
                </ListBox.Item>
                {runs.map((entry) => (
                  <ListBox.Item
                    id={entry.id}
                    key={entry.id}
                    textValue={generationBatchLabel(entry)}
                  >
                    {generationBatchLabel(entry)}
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <Chip size="sm" variant="soft">
            {tr('generated.visibleCount', { count: visibleCandidates.length })}
          </Chip>
          {selectedRun && (
            <Button
              className="gap-2"
              onPress={() => onOpenHistory(selectedRun)}
              size="sm"
              variant="ghost"
            >
              <Activity aria-hidden="true" size={16} />
              {tr('generated.viewRun')}
            </Button>
          )}
        </div>
        <div
          aria-label={tr('overview.ruleStatusLabel')}
          className="flex flex-wrap items-center gap-2"
        >
          {statuses.map((item) => (
            <Button
              aria-pressed={status === item.value}
              key={item.value}
              onPress={() => onStatusChange(item.value)}
              size="sm"
              variant={status === item.value ? 'primary' : 'ghost'}
            >
              {tr(item.labelKey)}
            </Button>
          ))}
        </div>
      </div>
      {selectedIds.size > 0 && (
        <div
          className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3"
          data-candidate-bulk-toolbar
        >
          <div className="flex items-center gap-3">
            <strong className="text-sm font-medium text-foreground">
              {tr('generated.selectedCount', { count: selectedIds.size })}
            </strong>
            <Button
              isDisabled={pendingBatchAction !== null}
              onPress={() => setSelectedIds(new Set())}
              size="sm"
              variant="ghost"
            >
              {tr('generated.clearSelection')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status !== 'accepted' && (
              <Button
                className="gap-2"
                isDisabled={pendingBatchAction !== null}
                onPress={() => void runBulkUpdate('accepted')}
                size="sm"
                variant="primary"
              >
                {pendingBatchAction === 'accepted'
                  ? <Spinner color="current" size="sm" />
                  : <Check aria-hidden="true" size={16} />}
                {tr('generated.bulkAccept')}
              </Button>
            )}
            {status !== 'rejected' && (
              <Button
                className="gap-2"
                isDisabled={pendingBatchAction !== null}
                onPress={() => void runBulkUpdate('rejected')}
                size="sm"
                variant="danger"
              >
                {pendingBatchAction === 'rejected'
                  ? <Spinner color="current" size="sm" />
                  : <X aria-hidden="true" size={16} />}
                {tr('generated.bulkReject')}
              </Button>
            )}
          </div>
        </div>
      )}
      <Card className="min-h-64 border border-border bg-surface shadow-none">
        <Card.Content className="p-0">
          {loading || historyLoading ? (
            <ViewLoading label={tr('overview.loadingRules', { status: tr(`status.${status}`) })} />
          ) : visibleCandidates.length === 0 ? (
            <EmptyRules />
          ) : (
            <Table className="rounded-none bg-transparent shadow-none">
              <Table.ScrollContainer>
                <Table.Content
                  aria-label={tr('overview.tableLabel', { status: tr(`status.${status}`) })}
                  onRowAction={(key) => {
                    if (pendingBatchAction !== null) return
                    toggleCandidateSelection(String(key))
                  }}
                >
                  <Table.Header>
                    <Table.Column>
                      <Checkbox
                        aria-label={tr('generated.selectAllVisible')}
                        isDisabled={pendingBatchAction !== null}
                        isIndeterminate={someVisibleSelected && !allVisibleSelected}
                        isSelected={allVisibleSelected}
                        onChange={(selected) => {
                          setSelectedIds(selected
                            ? new Set(visibleCandidates.map((candidate) => candidate.id))
                            : new Set())
                        }}
                        slot="selection"
                      >
                        <Checkbox.Content>
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                        </Checkbox.Content>
                      </Checkbox>
                    </Table.Column>
                    <Table.Column isRowHeader>{tr('overview.columns.rule')}</Table.Column>
                    <Table.Column>{tr('overview.columns.scope')}</Table.Column>
                    <Table.Column>{tr('overview.columns.confidence')}</Table.Column>
                    <Table.Column>{tr('overview.columns.actions')}</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {visibleCandidates.map((candidate) => (
                      <Table.Row
                        className={`cursor-pointer rounded-none outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [&>td]:rounded-none ${
                          selectedIds.has(candidate.id) ? 'bg-primary-soft' : ''
                        }`}
                        id={candidate.id}
                        key={candidate.id}
                      >
                        <Table.Cell>
                          <Checkbox
                            aria-label={tr('generated.selectCandidate', { rule: candidate.rule_text })}
                            isDisabled={pendingBatchAction !== null}
                            isSelected={selectedIds.has(candidate.id)}
                            onChange={(selected) => {
                              setSelectedIds((current) => {
                                const next = new Set(current)
                                if (selected) next.add(candidate.id)
                                else next.delete(candidate.id)
                                return next
                              })
                            }}
                            slot="selection"
                          >
                            <Checkbox.Content>
                              <Checkbox.Control>
                                <Checkbox.Indicator />
                              </Checkbox.Control>
                            </Checkbox.Content>
                          </Checkbox>
                        </Table.Cell>
                        <Table.Cell className="max-w-xl"><p className="line-clamp-2">{candidate.rule_text}</p></Table.Cell>
                        <Table.Cell className="text-muted">{candidate.project_slug ?? candidate.scope}</Table.Cell>
                        <Table.Cell><ConfidenceChip level={candidate.confidence_level} /></Table.Cell>
                        <Table.Cell>
                          {candidate.status === 'accepted' ? (
                            <Button className="gap-2" onPress={onOpenOutput} size="sm" variant="ghost">
                              <FileOutput aria-hidden="true" size={16} />
                              {tr('actions.publish')}
                            </Button>
                          ) : (
                            <Button className="gap-2" onPress={() => onReview(candidate)} size="sm" variant="ghost">
                              <SearchCheck aria-hidden="true" size={16} />
                              {tr(candidate.status === 'draft' ? 'actions.review' : 'actions.view')}
                            </Button>
                          )}
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
    </>
  )
}

function GenerationHistoryIndexPage({
  actionError,
  generation,
  history,
  loading,
  onOpenHistory,
  onOpenRun,
}: {
  actionError: string | null
  generation: GenerationStatus | null
  history: GenerationHistoryEntry[]
  loading: boolean
  onOpenHistory: (entry: GenerationHistoryEntry) => void
  onOpenRun: () => void
}) {
  return (
    <>
      {actionError && <div className="mb-4"><ErrorAlert message={actionError} title={tr('errors.history')} /></div>}
      <div className="mb-3 border-b border-border pb-4">
        <h2 className="text-lg font-medium text-foreground">{tr('history.recentRuns')}</h2>
        <p className="mt-1 text-sm text-muted">{tr('history.recentDescription')}</p>
      </div>
      {loading ? (
        <ViewLoading label={tr('history.loading')} />
      ) : history.length === 0 ? (
        <div className="border-y border-border px-4 py-12 text-center text-sm text-muted">{tr('history.empty')}</div>
      ) : (
        <div className="overflow-hidden border-y border-border">
          {history.map((entry) => {
            const isCurrent = entry.id === generation?.runId
            return (
              <button
                className="grid w-full cursor-pointer grid-cols-[minmax(0,1.2fr)_minmax(10rem,.8fr)_auto_auto] items-center gap-4 border-b border-border px-4 py-4 text-left transition-colors last:border-b-0 hover:bg-surface-hover max-md:grid-cols-[minmax(0,1fr)_auto]"
                key={entry.id}
                onClick={() => {
                  if (isCurrent && generation?.runId) onOpenRun()
                  else onOpenHistory(entry)
                }}
                type="button"
              >
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-medium text-foreground">{generationHistoryScopeLabel(entry)}</strong>
                  <span className="mt-1 block text-xs text-muted">{formatDateTime(entry.startedAt, currentLocale())}</span>
                </span>
                <span className="text-sm text-muted max-md:hidden">
                  {entry.evidence
                    ? tr('history.evidenceSummary', {
                        projects: entry.evidence.projectCount,
                        sessions: entry.evidence.totalSessions,
                      })
                    : tr('history.legacyEvidence')}
                </span>
                <span className="text-sm text-muted max-md:hidden">{tr('history.candidateCount', { count: entry.candidateCount })}</span>
                <span className="flex items-center justify-end gap-2">
                  <Chip color={generationStateColor(entry.status)} size="sm" variant="soft">{generationRunTitle(entry.status)}</Chip>
                  <ChevronRight aria-hidden="true" size={17} />
                </span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

function AgentInstructionDetailPage({
  agent,
  onBack,
}: {
  agent: GlobalInstructionAgent
  onBack: () => void
}) {
  const [record, setRecord] = useState<GlobalInstructionReadResult | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = record !== null && content !== record.content

  function load(): void {
    setLoading(true)
    setError(null)
    void afterNextPaint(() =>
      window.api.invoke<GlobalInstructionReadResult>('rules.instructions.read', agent),
    )
      .then((result) => {
        setRecord(result)
        setContent(result.content)
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => setLoading(false))
  }

  useEffect(load, [agent])

  async function save(): Promise<void> {
    if (!record || saving) return
    setSaving(true)
    setError(null)
    try {
      const saved = await afterNextPaint(() =>
        window.api.invoke<GlobalInstructionReadResult>(
          'rules.instructions.save',
          agent,
          {
            content,
            expectedRevision: record.revision,
          },
        ),
      )
      setRecord(saved)
      setContent(saved.content)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <nav aria-label={tr('instructions.breadcrumb')} className="mb-5 flex flex-wrap items-center gap-2 text-sm text-muted">
        <button className="cursor-pointer hover:text-foreground" onClick={onBack} type="button">
          {tr('instructions.rules')}
        </button>
        <span>/</span>
        <span>{tr('instructions.title')}</span>
        <span>/</span>
        <span className="text-foreground">{instructionAgentLabel(agent)}</span>
      </nav>
      <PageHeader
        description={tr('instructions.globalDescription', { agent: instructionAgentLabel(agent) })}
        title={tr('instructions.globalTitle', { agent: instructionAgentLabel(agent) })}
      />
      {error && (
        <div className="mb-4">
          <ErrorAlert message={error} title={tr('errors.updateInstructions')} />
        </div>
      )}
      <Card className="border border-border bg-surface shadow-none">
        <Card.Header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <code className="min-w-0 truncate text-sm text-foreground">
            {record?.source.path ?? tr('instructions.resolving')}
          </code>
          {record && (
            <Chip color={record.source.status === 'present' ? 'success' : 'warning'} size="sm" variant="soft">
              {record.source.status === 'present' ? tr('status.editable') : tr('status.createOnSave')}
            </Chip>
          )}
        </Card.Header>
        <Card.Content className="p-0">
          {loading ? (
            <ViewLoading label={tr('instructions.loadingAgent', { agent: instructionAgentLabel(agent) })} />
          ) : record ? (
            <textarea
              aria-label={tr('instructions.contentLabel', { agent: instructionAgentLabel(agent) })}
              className="min-h-[25rem] w-full resize-y border-0 bg-background/60 p-5 font-mono text-sm leading-7 text-foreground outline-none"
              onChange={(event) => setContent(event.currentTarget.value)}
              placeholder={tr('instructions.placeholder', { agent: instructionAgentLabel(agent) })}
              spellCheck={false}
              value={content}
            />
          ) : null}
        </Card.Content>
        <Card.Footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3.5">
          <span className="text-xs text-muted">
            {record?.modifiedAt
              ? tr('instructions.modified', {
                  size: formatInstructionSize(record.sizeBytes),
                  time: formatDateTime(record.modifiedAt, currentLocale()),
                })
              : tr('instructions.separateHint')}
          </span>
          <div className="flex gap-2">
            {error?.includes('自打开后已发生变化') && (
              <Button onPress={load} variant="ghost">{tr('actions.reload')}</Button>
            )}
            <Button onPress={onBack} variant="ghost">{tr('actions.cancel')}</Button>
            <Button
              className="gap-2 bg-primary text-primary-foreground"
              isDisabled={!record || !dirty || saving}
              onPress={() => void save()}
            >
              {saving ? <Spinner color="current" size="sm" /> : <Save aria-hidden="true" size={16} />}
              {record?.source.status === 'missing' ? tr('actions.createFile') : tr('actions.saveChanges')}
            </Button>
          </div>
        </Card.Footer>
      </Card>
      <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-xl border border-border bg-surface px-5 py-4">
        <FilePenLine aria-hidden="true" className="mt-0.5 text-muted" size={18} />
        <div>
          <strong className="text-sm font-medium text-foreground">{tr('instructions.separateTitle')}</strong>
          <p className="mt-1 text-sm text-muted">
            {tr('instructions.separateDescription')}
          </p>
        </div>
      </div>
    </>
  )
}

function AgentMemoryDetailPage({
  source,
  onBack,
}: {
  source: AutoMemorySource
  onBack: () => void
}) {
  const [record, setRecord] = useState<AutoMemoryReadResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let current = true
    setLoading(true)
    setError(null)
    setRecord(null)
    void afterNextPaint(() =>
      window.api.invoke<AutoMemoryReadResult>(
        'rules.memories.read',
        source.agent,
        source.id,
      ),
    )
      .then((value) => {
        if (current) setRecord(value)
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [refresh, source.agent, source.id])

  return (
    <>
      <nav aria-label={tr('memory.breadcrumb')} className="mb-5 flex flex-wrap items-center gap-2 text-sm text-muted">
        <button className="cursor-pointer hover:text-foreground" onClick={onBack} type="button">
          {tr('memory.rules')}
        </button>
        <span>/</span>
        <button className="cursor-pointer hover:text-foreground" onClick={onBack} type="button">
          {tr('memory.title')}
        </button>
        <span>/</span>
        <span className="text-foreground">{autoMemorySourceTitle(source)}</span>
      </nav>
      <PageHeader
        description={source.scope === 'project'
          ? tr('memory.projectDescription')
          : tr('memory.codexDescription')}
        title={autoMemorySourceTitle(source)}
      />
      {error && (
        <div className="mb-4">
          <ErrorAlert message={error} title={tr('memory.errors.read')} />
        </div>
      )}
      <Card className="border border-border bg-surface shadow-none">
        <Card.Header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <code className="min-w-0 truncate text-sm text-foreground">
            {record?.source.path ?? source.path}
          </code>
          <Chip color="success" size="sm" variant="soft">{tr('memory.readOnly')}</Chip>
        </Card.Header>
        <Card.Content className="p-0">
          {loading ? (
            <ViewLoading label={tr('memory.loadingSource', { source: autoMemorySourceTitle(source) })} />
          ) : record ? (
            <pre
              aria-label={tr('memory.contentLabel', { source: autoMemorySourceTitle(source) })}
              className="min-h-[25rem] whitespace-pre-wrap break-words bg-background/60 p-5 font-mono text-sm leading-7 text-foreground"
            >
              {record.content}
            </pre>
          ) : null}
        </Card.Content>
        <Card.Footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3.5">
          <span className="text-xs text-muted">
            {record?.source.modifiedAt
              ? tr('memory.modified', {
                  size: formatInstructionSize(record.source.sizeBytes),
                  time: formatDateTime(record.source.modifiedAt, currentLocale()),
                })
              : tr('memory.readOnlyHint')}
          </span>
          <div className="flex gap-2">
            <Button onPress={() => setRefresh((value) => value + 1)} variant="ghost">
              {tr('actions.reload')}
            </Button>
            <Button onPress={onBack} variant="ghost">{tr('memory.back')}</Button>
          </div>
        </Card.Footer>
      </Card>
      {source.note && (
        <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-xl border border-border bg-surface px-5 py-4">
          <Brain aria-hidden="true" className="mt-0.5 text-muted" size={18} />
          <div>
            <strong className="text-sm font-medium text-foreground">{tr('memory.scopeNoteTitle')}</strong>
            <p className="mt-1 text-sm text-muted">{tr('memory.codexScopeNote')}</p>
          </div>
        </div>
      )}
    </>
  )
}

function GenerateRulesPage({
  error,
  onBack,
  onError,
  onStarted,
  initialProjectSlug,
}: {
  error: string | null
  onBack: () => void
  onError: (value: string | null) => void
  onStarted: (chatId: string) => void
  initialProjectSlug?: string | null
}) {
  const [mode, setMode] = useState<GenerateMode>(initialProjectSlug ? 'projects' : 'changed7d')
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjects, setSelectedProjects] = useState<string[]>(
    initialProjectSlug ? [initialProjectSlug] : [],
  )
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [config, setConfig] = useState<LlmConfig | null>(null)
  const [providerSnapshot, setProviderSnapshot] = useState<ProviderSnapshot>({
    entries: [],
    refreshing: false,
  })
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<LlmConfig['effort']>('medium')
  const [fastMode, setFastMode] = useState(false)

  useEffect(() => {
    let current = true
    void window.api
      .invoke<Project[]>('projects.list')
      .then((rows) => {
        if (current) setProjects(rows)
      })
      .catch((reason: unknown) => {
        if (current) setProjectsError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      current = false
    }
  }, [])

  useEffect(() => {
    let current = true
    const onProvidersUpdated = (value: unknown) => {
      if (current && value && typeof value === 'object') {
        setProviderSnapshot(value as ProviderSnapshot)
      }
    }
    window.api.onEvent('settings.providers.updated', onProvidersUpdated)
    void afterNextPaint(() =>
      Promise.all([
        window.api.invoke<LlmConfig>('settings.load'),
        window.api.invoke<ProviderSnapshot>('settings.providers.snapshot'),
      ]),
    )
      .then(([value, snapshot]) => {
        if (!current) return
        setConfig(value)
        setProviderSnapshot(snapshot)
        setProvider(value.provider)
        setModel(value.model ?? null)
        setEffort(value.effort)
        setFastMode(value.fastMode ?? false)
      })
      .catch((reason: unknown) => {
        if (current) {
          onError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      current = false
      window.api.offEvent('settings.providers.updated', onProvidersUpdated)
    }
  }, [onError])

  const availableModels = useMemo(() => {
    const models =
      providerSnapshot.entries.find((entry) => entry.id === provider)?.models ?? []
    const byId = new Map(models.map((item) => [item.id, item]))
    if (provider === config?.provider && config.model && !byId.has(config.model)) {
      byId.set(config.model, {
        id: config.model,
        label: config.model,
        source: 'custom',
      })
    }
    return [...byId.values()]
  }, [config, provider, providerSnapshot])

  function selectProvider(nextProvider: ProviderId): void {
    setProvider(nextProvider)
    setModel(nextProvider === config?.provider ? config.model ?? null : null)
  }

  function toggleProject(slug: string): void {
    setSelectedProjects((current) =>
      current.includes(slug)
        ? current.filter((item) => item !== slug)
        : [...current, slug],
    )
  }

  async function generate(): Promise<void> {
    if (mode === 'projects' && selectedProjects.length === 0) return
    setStarting(true)
    onError(null)
    try {
      const result = await afterNextPaint(() =>
        window.api.invoke<{ chatId: string; runId: string }>('rules.chat.start', {
          mode,
          projects: mode === 'projects' ? selectedProjects : undefined,
          provider,
          model,
          effort,
          fastMode,
        } satisfies Partial<GenerationRequest>),
      )
      onStarted(result.chatId)
    } catch (reason: unknown) {
      onError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setStarting(false)
    }
  }

  const scopeSummary = mode === 'projects'
    ? tr('generate.scopeSelected', { count: selectedProjects.length })
    : mode === 'full'
      ? tr('generate.scopeFull', { count: projects.length })
      : tr('generate.scopeRecent', { count: projects.length })

  return (
    <PageShell archetype="task" width="wide">
      <div>
        <BackButton label={tr('actions.back')} onPress={onBack} />
        <PageHeader
          className="mb-0"
          description={tr('generate.description')}
          title={tr('generate.title')}
        />
      </div>
      {error && <div className="mb-4"><ErrorAlert message={error} title={tr('errors.generate')} /></div>}
      <SupportingPaneLayout
        paneLabel={tr('generate.runConfiguration')}
        paneWidth="lg"
      >
          <article className="min-w-0">
            <div className="mb-4">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-primary">
                {tr('generate.evidenceEyebrow')}
              </p>
              <h2 className="mt-2 text-xl font-semibold text-foreground">
                {tr('generate.evidenceTitle')}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {tr('generate.evidenceDescription')}
              </p>
            </div>
            <div className="grid content-start gap-4">
                    <div className="overflow-hidden rounded-xl border border-border bg-surface">
                      {generationModes.map((item) => (
                        <button
                          aria-pressed={mode === item.value}
                          className={`grid w-full cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-3 border-b border-l-2 border-border p-4 text-left transition-colors last:border-b-0 hover:bg-surface-hover ${
                            mode === item.value
                              ? 'border-l-primary bg-primary/10'
                              : 'border-l-transparent'
                          }`}
                          disabled={starting}
                          key={item.value}
                          onClick={() => setMode(item.value)}
                          type="button"
                        >
                          <span className={`mt-0.5 size-4 rounded-full border ${
                            mode === item.value ? 'border-[5px] border-primary' : 'border-muted'
                          }`} />
                          <span>
                            <strong className="block text-sm font-medium text-foreground">{tr(item.labelKey)}</strong>
                            <span className="mt-1 block text-sm text-muted">{tr(item.descriptionKey)}</span>
                          </span>
                          <span className="text-xs text-muted">
                            {item.value === 'projects'
                              ? tr('generate.available', { count: projects.length })
                              : item.value === 'full'
                                ? tr('generate.allSessions')
                                : tr('generate.lastDays')}
                          </span>
                        </button>
                      ))}
                    </div>

                    {mode === 'projects' && (
                      <div className="rounded-xl border border-border bg-surface p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <h2 className="text-sm font-medium text-foreground">{tr('generate.projectGroups')}</h2>
                          <Chip size="sm" variant="soft">{tr('generate.selected', { count: selectedProjects.length })}</Chip>
                        </div>
                        <div className="flex max-h-44 flex-wrap content-start gap-2 overflow-y-auto">
                          {projectsError ? (
                            <p className="text-sm text-danger">{projectsError}</p>
                          ) : projects.length === 0 ? (
                            <p className="text-sm text-muted">{tr('generate.noProjects')}</p>
                          ) : (
                            projects.map((project) => {
                              const selected = selectedProjects.includes(project.slug)
                              return (
                                <Button
                                  aria-pressed={selected}
                                  isDisabled={starting}
                                  key={project.slug}
                                  onPress={() => toggleProject(project.slug)}
                                  size="sm"
                                  variant={selected ? 'primary' : 'ghost'}
                                >
                                  {project.slug}
                                </Button>
                              )
                            })
                          )}
                        </div>
                      </div>
                    )}
            </div>
          </article>

          <div className="overflow-hidden rounded-xl border border-border bg-surface @min-[64rem]:sticky @min-[64rem]:top-6">
            <div className="px-4 py-4">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
                {tr('generate.configurationEyebrow')}
              </p>
              <h2 className="mt-2 text-base font-semibold text-foreground">
                {tr('generate.runConfiguration')}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {tr('generate.runConfigurationDescription')}
              </p>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_11rem] items-center gap-3 border-t border-border px-4 py-3">
              <p className="text-sm font-medium text-foreground">{tr('generate.agent')}</p>
                    <Select
                      aria-label={tr('generate.agent')}
                      isDisabled={starting || !config}
                      onSelectionChange={(key) => selectProvider(String(key) as ProviderId)}
                      selectedKey={provider}
                    >
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {generationProviders
                            .filter((item) => config?.providers?.[item.id]?.enabled !== false)
                            .map((item) => (
                              <ListBox.Item id={item.id} key={item.id} textValue={item.label}>
                                {item.label}
                              </ListBox.Item>
                            ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_11rem] items-center gap-3 border-t border-border px-4 py-3">
              <p className="text-sm font-medium text-foreground">{tr('generate.model')}</p>
                    <Select
                      aria-label={tr('generate.model')}
                      isDisabled={starting || !config}
                      onSelectionChange={(key) =>
                        setModel(String(key) === DEFAULT_MODEL_KEY ? null : String(key))
                      }
                      selectedKey={model ?? DEFAULT_MODEL_KEY}
                    >
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          <ListBox.Item
                            id={DEFAULT_MODEL_KEY}
                            textValue={tr('generate.providerDefaultModel')}
                          >
                            {tr('generate.providerDefaultModel')}
                          </ListBox.Item>
                          {availableModels.map((item) => (
                            <ListBox.Item id={item.id} key={item.id} textValue={item.label}>
                              {item.label}
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_11rem] items-center gap-3 border-t border-border px-4 py-3">
              <p className="text-sm font-medium text-foreground">{tr('generate.effort')}</p>
                    <Select
                      aria-label={tr('generate.effort')}
                      isDisabled={starting || !config}
                      onSelectionChange={(key) =>
                        setEffort(String(key) as LlmConfig['effort'])
                      }
                      selectedKey={effort}
                    >
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {generationEfforts.map((item) => (
                            <ListBox.Item
                              id={item}
                              key={item}
                              textValue={tr(`generate.efforts.${item}`)}
                            >
                              {tr(`generate.efforts.${item}`)}
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_11rem] items-center gap-3 border-t border-border px-4 py-3">
              <p className="text-sm font-medium text-foreground">{tr('generate.fastMode')}</p>
                    <Switch
                      aria-label={tr('generate.fastMode')}
                      className="justify-self-end"
                      isDisabled={starting || !config}
                      isSelected={fastMode}
                      onChange={setFastMode}
                    >
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                      </Switch.Content>
                    </Switch>
            </div>
            <div
              className="border-t border-border bg-surface-hover/40 p-4"
              data-generation-action="true"
            >
              <p className="mb-3 text-xs text-muted">{scopeSummary}</p>
              <Button
                className="w-full gap-2 bg-primary text-primary-foreground"
                isDisabled={!config || starting || (mode === 'projects' && selectedProjects.length === 0)}
                onPress={() => void generate()}
              >
                {starting ? (
                  <Spinner aria-label={tr('generate.startingLabel')} color="current" size="sm" />
                ) : (
                  <Sparkles aria-hidden="true" size={17} />
                )}
                {starting ? tr('actions.starting') : tr('actions.continueChat')}
              </Button>
            </div>
          </div>
      </SupportingPaneLayout>
    </PageShell>
  )
}

function GenerationRunPage({
  generation,
  error,
  onBack,
  onCancel,
  onReview,
}: {
  generation: GenerationStatus
  error: string | null
  onBack: () => void
  onCancel: () => void
  onReview: () => void
}) {
  const remembered = generation.runId
    ? generationRunMemory.get(generation.runId)
    : undefined
  const [selectedPhase, setSelectedPhase] = useState<GenerationPhaseKey>(
    remembered?.phase ?? 'evidence',
  )
  const [selectedCandidate, setSelectedCandidate] = useState<{
    projectSlug: string
    candidate: ProjectGenerationCandidate
  } | null>(null)
  const [following, setFollowing] = useState(true)
  const outputRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = outputRef.current
    if (!container) return
    const memory = generation.runId
      ? generationRunMemory.get(generation.runId)
      : undefined
    if (memory && memory.scrollTop > 0) {
      container.scrollTop = memory.scrollTop
      setFollowing(
        container.scrollHeight - container.scrollTop - container.clientHeight < 48,
      )
    } else if (following) {
      container.scrollTop = container.scrollHeight
    }
  }, [generation.runId, selectedPhase])

  useEffect(() => {
    const container = outputRef.current
    if (!container || !following) return
    container.scrollTop = container.scrollHeight
  }, [following, generation.projectResponses.length])

  useEffect(() => {
    if (!generation.runId) return
    const previous = generationRunMemory.get(generation.runId)
    generationRunMemory.set(generation.runId, {
      phase: selectedPhase,
      scrollTop: previous?.scrollTop ?? 0,
    })
  }, [generation.runId, selectedPhase])

  const completed = generation.state === 'completed'
  const active = generation.state === 'running' || generation.state === 'cancelling'
  const phases = generationPhases(generation)

  return (
    <>
      <BackButton label={tr('actions.back')} onPress={onBack} />
      <PageHeader
        actions={
          <div className="flex flex-wrap gap-2">
            {completed && (generation.progress?.candidateCount ?? 0) > 0 && (
              <Button
                className="gap-2 bg-primary text-primary-foreground"
                onPress={onReview}
              >
                {tr('run.reviewDrafts', { count: generation.progress?.candidateCount ?? 0 })}
                <ChevronRight aria-hidden="true" size={17} />
              </Button>
            )}
            {active && (
              <Button
                className="gap-2"
                isDisabled={generation.state === 'cancelling'}
                onPress={onCancel}
                variant="ghost"
              >
                {generation.state === 'cancelling'
                  ? <Spinner color="current" size="sm" />
                  : <Square aria-hidden="true" size={15} />}
                {generation.state === 'cancelling' ? tr('actions.cancelling') : tr('actions.stopGeneration')}
              </Button>
            )}
          </div>
        }
        description={`${generationScopeLabel(generation)} · ${generationRunMeta(generation)}`}
        title={generationRunTitle(generation.state)}
      />

      {error && (
        <div className="mb-4">
          <ErrorAlert message={error} title={tr('errors.run')} />
        </div>
      )}

      <Card className="overflow-hidden border border-border bg-surface shadow-none">
        <Card.Content className="grid min-h-[34rem] grid-cols-[minmax(0,1fr)_18rem] p-0 max-xl:grid-cols-1">
          <section className="grid min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] border-r border-border max-xl:border-b max-xl:border-r-0">
            <div
              aria-label={tr('run.progressLabel')}
              className="grid grid-cols-4 border-b border-border bg-background/60"
            >
              {phases.map((phase) => (
                <button
                  aria-pressed={selectedPhase === phase.key}
                  className={`relative grid min-w-0 cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-2 px-3 py-3 text-left transition-colors hover:bg-surface-hover ${
                    selectedPhase === phase.key ? 'bg-primary-soft' : ''
                  }`}
                  data-phase={phase.key}
                  key={phase.key}
                  onClick={() => setSelectedPhase(phase.key)}
                  type="button"
                >
                  <span className={`grid size-4 place-items-center rounded-full ${
                    phase.status === 'active'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-surface-hover text-muted'
                  }`}>
                    {phase.status === 'done'
                      ? <Check aria-hidden="true" size={11} />
                      : phase.status === 'active'
                        ? <Sparkles aria-hidden="true" size={10} />
                        : <Circle aria-hidden="true" size={7} />}
                  </span>
                  <span className={`truncate text-xs font-medium ${
                    selectedPhase === phase.key ? 'text-foreground' : 'text-muted'
                  }`}>
                    {phase.label}
                  </span>
                </button>
              ))}
            </div>
            <div
              className="min-h-[30rem] overflow-y-auto bg-background p-5"
              onScroll={(event) => {
                const target = event.currentTarget
                const atLatest =
                  target.scrollHeight - target.scrollTop - target.clientHeight < 48
                setFollowing(atLatest)
                if (generation.runId) {
                  generationRunMemory.set(generation.runId, {
                    phase: selectedPhase,
                    scrollTop: target.scrollTop,
                  })
                }
              }}
              ref={outputRef}
            >
              {selectedPhase === 'evidence' ? (
                <EvidenceCollectionView active={active} generation={generation} />
              ) : (
                <div className="mx-auto grid w-full max-w-3xl gap-6 py-3">
                  <div className="flex justify-end">
                    <div className="max-w-xl rounded-2xl rounded-tr-md bg-surface-hover px-4 py-3 text-sm leading-6 text-foreground">
                      {tr('run.request', { scope: generationScopeLabel(generation) })}
                    </div>
                  </div>
                  <article className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
                    <span className="grid size-8 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
                      M
                    </span>
                    <div className="min-w-0">
                      <ProjectResponseConversation
                        active={active}
                        generation={generation}
                        onOpenCandidate={(projectSlug, candidate) => {
                          setSelectedCandidate({ projectSlug, candidate })
                        }}
                      />
                      <details className="mt-5 border-t border-border pt-4 text-xs text-muted">
                        <summary className="cursor-pointer font-medium text-foreground">
                          {tr('run.diagnostic')}
                        </summary>
                        {generation.outputTruncated && (
                          <p className="mt-2 text-warning">{tr('run.truncated')}</p>
                        )}
                        <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-3 font-mono">
                          {generation.output || tr('run.noRawOutput')}
                        </pre>
                      </details>
                    </div>
                  </article>
                </div>
              )}
              {!following && (
                <Button
                  className="sticky bottom-3 ml-auto flex gap-2"
                  onPress={() => {
                    setFollowing(true)
                    const container = outputRef.current
                    if (container) container.scrollTop = container.scrollHeight
                  }}
                  size="sm"
                  variant="primary"
                >
                  <ArrowDown aria-hidden="true" size={15} />
                  {tr('actions.jumpLatest')}
                </Button>
              )}
            </div>
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
              <span className="flex items-center gap-2 text-xs text-muted">
                {active && <Spinner color="accent" size="sm" />}
                {active ? progressDetail(generation.progress ?? null) : generationRunTitle(generation.state)}
              </span>
              <span className="text-xs text-muted">{tr('run.privacy')}</span>
            </footer>
          </section>
          <aside className="p-5">
            <section>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">{tr('run.context')}</h2>
                <Chip color={generationStateColor(generation.state)} size="sm" variant="soft">
                  {generationRunTitle(generation.state)}
                </Chip>
              </div>
              <p className="mt-1 text-xs text-muted">{tr('run.contextDescription')}</p>
              <div className="mt-4 grid gap-3">
                <Detail label={tr('fields.scope')} value={generationScopeLabel(generation)} />
                <Detail label={tr('fields.run')} value={generation.runId?.slice(0, 8) ?? tr('fields.preparing')} />
                <Detail label={tr('fields.result')} value={tr('counts.candidates', { count: generation.progress?.candidateCount ?? 0 })} />
                <Detail label={tr('fields.storage')} value={tr('fields.metadataOnly')} />
              </div>
            </section>
            <section className="mt-6 border-t border-border pt-5">
              <h2 className="text-sm font-medium text-foreground">{tr('run.evidenceSnapshot')}</h2>
              <p className="mt-1 text-xs text-muted">{tr('run.snapshotDescription')}</p>
              {generation.evidence ? (
                <div className="mt-3 grid border-t border-border">
                  {generation.evidence.projects.map((project) => (
                    <div
                      className="flex items-center justify-between gap-3 border-b border-border py-2.5 text-xs"
                      key={project.slug}
                    >
                      <strong className="min-w-0 truncate font-medium text-foreground">{project.slug}</strong>
                      <span className="shrink-0 text-muted">{tr('counts.sessions', { count: project.sessionIds.length })}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2 border-y border-border py-3 text-xs text-muted">
                  <Spinner color="accent" size="sm" />
                  {tr('run.preparingSnapshot')}
                </div>
              )}
            </section>
          </aside>
        </Card.Content>
      </Card>

      {false && (<>
      <div className="mb-4 grid grid-cols-3 gap-3 border-y border-border py-4 max-md:grid-cols-1">
        <RunMetric label={tr('generate.evidenceScope')} value={generationScopeLabel(generation)} />
        <RunMetric
          label={tr('fields.sourceCoverage')}
          value={generation.evidence
            ? `${generation.evidence?.projects.length ?? 0} projects · ${generation.evidence?.totalSessions ?? 0} sessions`
            : 'Preparing evidence'}
        />
        <RunMetric
          label={tr('fields.result')}
          value={`${generation.progress?.candidateCount ?? 0} candidates · ${generation.state}`}
        />
      </div>

      <Card className="border border-border bg-surface shadow-none">
        <Card.Content className="grid min-h-[30rem] grid-cols-[17rem_minmax(0,1fr)] p-0 max-lg:grid-cols-1">
          <aside className="border-r border-border p-5 max-lg:border-b max-lg:border-r-0">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-medium text-foreground">{tr('run.runProgress')}</h2>
              <Chip
                color={generationStateColor(generation.state)}
                size="sm"
                variant="soft"
              >
                {generation.state}
              </Chip>
            </div>
            <div className="grid gap-1">
              {phases.map((phase) => (
                <button
                  aria-pressed={selectedPhase === phase.key}
                  className={`grid w-full cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)] gap-2 rounded-lg border px-2 py-3 text-left transition-colors hover:bg-surface-hover ${
                    selectedPhase === phase.key
                      ? 'border-primary bg-primary-soft'
                      : 'border-transparent'
                  }`}
                  data-phase={phase.key}
                  key={phase.key}
                  onClick={() => setSelectedPhase(phase.key)}
                  type="button"
                >
                  <span className={`grid size-5 place-items-center rounded-full ${
                    phase.status === 'active'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-surface-hover text-muted'
                  }`}>
                    {phase.status === 'done'
                      ? <Check aria-hidden="true" size={13} />
                      : phase.status === 'active'
                        ? <Sparkles aria-hidden="true" size={12} />
                        : <Circle aria-hidden="true" size={9} />}
                  </span>
                  <span className="grid gap-1">
                    <span className="font-medium text-foreground">{phase.label}</span>
                    <span className="text-xs text-muted">{phase.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="min-w-0 p-5">
            {selectedPhase === 'evidence' ? (
              <EvidenceCollectionView
                active={active}
                generation={generation}
              />
            ) : (
              <div className="grid min-h-[30rem] grid-cols-[13rem_minmax(0,1fr)] gap-5 max-xl:grid-cols-1">
                <ProcessTimeline active={active} generation={generation} />
                <div className="relative min-w-0">
                  <div
                    className="max-h-[34rem] min-h-[30rem] overflow-y-auto rounded-xl bg-background p-5"
                    onScroll={(event) => {
                      const target = event.currentTarget
                      const atLatest =
                        target.scrollHeight - target.scrollTop - target.clientHeight < 48
                      setFollowing(atLatest)
                      if (generation.runId) {
                        generationRunMemory.set(generation.runId, {
                          phase: selectedPhase,
                          scrollTop: target.scrollTop,
                        })
                      }
                    }}
                    ref={outputRef}
                  >
                    <ProjectResponseConversation
                      active={active}
                      generation={generation}
                      onOpenCandidate={(projectSlug, candidate) => {
                        setSelectedCandidate({ projectSlug, candidate })
                      }}
                    />
                    <details className="mt-5 border-t border-border pt-4 text-xs text-muted">
                      <summary className="cursor-pointer font-medium text-foreground">
                        Diagnostic · Raw response
                      </summary>
                      {generation.outputTruncated && (
                        <p className="mt-2 text-warning">
                          The beginning of this in-memory output was truncated.
                        </p>
                      )}
                      <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-3 font-mono">
                        {generation.output || 'No raw Provider output available.'}
                      </pre>
                    </details>
                  </div>
                  {!following && (
                    <Button
                      className="absolute bottom-3 right-3 gap-2"
                      onPress={() => {
                        setFollowing(true)
                        const container = outputRef.current
                        if (container) container.scrollTop = container.scrollHeight
                      }}
                      size="sm"
                      variant="primary"
                    >
                      <ArrowDown aria-hidden="true" size={15} />
                      Jump to latest
                    </Button>
                  )}
                </div>
              </div>
            )}
          </section>
        </Card.Content>
      </Card>
      </>)}
      {selectedCandidate && (
        <CandidateDetailsModal
          candidate={selectedCandidate.candidate}
          onClose={() => setSelectedCandidate(null)}
          projectSlug={selectedCandidate.projectSlug}
        />
      )}
    </>
  )
}

function HistoricalGenerationPage({
  entry,
  onBack,
  onPublish,
  onReview,
}: {
  entry: GenerationHistoryEntry
  onBack: () => void
  onPublish: () => void
  onReview: (candidate: RuleCandidate) => void
}) {
  const projects = entry.evidence?.projects ?? []
  const excerptCount = projects.reduce(
    (total, project) => total + project.excerptCount,
    0,
  )
  const acceptedCount = entry.candidates.filter(
    (candidate) => candidate.status === 'accepted',
  ).length
  const draftCount = entry.candidates.filter(
    (candidate) => candidate.status === 'draft',
  ).length

  return (
    <>
      <BackButton label={tr('actions.back')} onPress={onBack} />
      <PageHeader
        actions={
          <Button
            className="gap-2 bg-primary text-primary-foreground"
            isDisabled={acceptedCount === 0}
            onPress={onPublish}
          >
            <FileOutput aria-hidden="true" size={16} />
            {tr('actions.publishAccepted')}
          </Button>
        }
        description={tr('history.runDescription', {
          time: formatDateTime(entry.startedAt, currentLocale()),
          run: entry.id.slice(0, 8),
        })}
        title={tr('history.title')}
      />

      <Card className="overflow-hidden border border-border bg-surface shadow-none">
        <Card.Content className="grid min-h-[34rem] grid-cols-[minmax(0,1fr)_18rem] p-0 max-xl:grid-cols-1">
          <section className="grid min-w-0 grid-rows-[auto_minmax(0,1fr)] border-r border-border max-xl:border-b max-xl:border-r-0">
            <div aria-label={tr('run.progressLabel')} className="grid grid-cols-3 border-b border-border bg-background/60">
              {[tr('generate.prepareEvidence'), tr('generate.generateRules'), tr('actions.review')].map((label) => (
                <div className="flex items-center gap-2 px-4 py-3 text-xs font-medium text-foreground" key={label}>
                  <span className="grid size-4 place-items-center rounded-full bg-primary text-primary-foreground">
                    <Check aria-hidden="true" size={11} />
                  </span>
                  {label}
                </div>
              ))}
            </div>
            <div className="min-h-[30rem] overflow-y-auto bg-background p-5">
              <div className="mx-auto grid w-full max-w-3xl gap-6 py-3">
                <div className="flex justify-end">
                  <div className="max-w-xl rounded-2xl rounded-tr-md bg-surface-hover px-4 py-3 text-sm leading-6 text-foreground">
                    {tr('run.request', { scope: generationHistoryScopeLabel(entry) })}
                  </div>
                </div>
                <article className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
                  <span className="grid size-8 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">M</span>
                  <div className="min-w-0">
                    <p className="text-sm leading-7 text-foreground">
                      {tr('history.completedFromSnapshot')}
                    </p>
                    <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface">
                      <div className="flex items-center justify-between gap-3 px-4 py-3.5">
                        <span>
                          <strong className="block text-sm font-medium text-foreground">{tr('history.snapshotTitle')}</strong>
                          <span className="mt-1 block text-xs text-muted">{tr('history.snapshotDescription')}</span>
                        </span>
                        <Chip color={generationStateColor(entry.status)} size="sm" variant="soft">{generationRunTitle(entry.status)}</Chip>
                      </div>
                      <div className="grid grid-cols-3 border-t border-border max-sm:grid-cols-1">
                        <RunMetric label={tr('fields.projectGroups')} value={entry.evidence ? String(entry.evidence.projectCount) : tr('status.legacy')} />
                        <RunMetric label={tr('fields.sessions')} value={entry.evidence ? String(entry.evidence.totalSessions) : tr('status.unavailable')} />
                        <RunMetric label={tr('fields.candidates')} value={String(entry.candidateCount)} />
                      </div>
                    </div>
                    <div className="mt-5 grid gap-2">
                      {entry.candidates.map((candidate) => (
                        <button
                          className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-hover"
                          key={candidate.id}
                          onClick={() => onReview(candidate)}
                          type="button"
                        >
                          <span>
                            <strong className="line-clamp-2 text-sm font-medium text-foreground">{candidate.rule_text}</strong>
                            <span className="mt-1 block text-xs text-muted">{candidate.project_slug ?? tr('history.global')} · {tr('confidence', { level: candidate.confidence_level })}</span>
                          </span>
                          <Chip color={candidate.status === 'accepted' ? 'success' : candidate.status === 'rejected' ? 'danger' : 'default'} size="sm" variant="soft">
                            {tr(`status.${candidate.status}`, { defaultValue: candidate.status })}
                          </Chip>
                        </button>
                      ))}
                    </div>
                  </div>
                </article>
              </div>
            </div>
          </section>
          <aside className="p-5">
            <section>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">{tr('run.context')}</h2>
                <Chip color={generationStateColor(entry.status)} size="sm" variant="soft">{generationRunTitle(entry.status)}</Chip>
              </div>
              <p className="mt-1 text-xs text-muted">{tr('history.restored')}</p>
              <div className="mt-4 grid gap-3">
                <Detail label={tr('fields.scope')} value={generationHistoryScopeLabel(entry)} />
                <Detail label={tr('fields.started')} value={formatDateTime(entry.startedAt, currentLocale())} />
                <Detail label={tr('fields.result')} value={tr('counts.candidates', { count: entry.candidateCount })} />
                <Detail label={tr('fields.storage')} value={tr('fields.metadataOnly')} />
              </div>
            </section>
            <section className="mt-6 border-t border-border pt-5">
              <h2 className="text-sm font-medium text-foreground">{tr('run.evidenceSnapshot')}</h2>
              <p className="mt-1 text-xs text-muted">{tr('run.snapshotDescription')}</p>
              <div className="mt-3 grid border-t border-border">
                {projects.map((project) => (
                  <div className="flex items-center justify-between gap-3 border-b border-border py-2.5 text-xs" key={project.slug}>
                    <strong className="min-w-0 truncate font-medium text-foreground">{project.slug}</strong>
                    <span className="shrink-0 text-muted">{tr('counts.sessions', { count: project.sessionIds.length })}</span>
                  </div>
                ))}
              </div>
            </section>
            <Button className="mt-6 w-full gap-2" isDisabled={acceptedCount === 0} onPress={onPublish} variant="ghost">
              <FileOutput aria-hidden="true" size={16} />
              {tr('actions.publishAccepted')}
            </Button>
          </aside>
        </Card.Content>
      </Card>

      {false && (<>
      <div className="mb-4 grid grid-cols-3 gap-3 border-y border-border py-4 max-md:grid-cols-1">
        <RunMetric label={tr('generate.evidenceScope')} value={generationHistoryScopeLabel(entry)} />
        <RunMetric
          label={tr('fields.sourceCoverage')}
          value={entry.evidence
            ? `${entry.evidence?.projectCount ?? 0} projects · ${entry.evidence?.totalSessions ?? 0} sessions`
            : 'Legacy summary unavailable'}
        />
        <RunMetric
          label={tr('fields.result')}
          value={`${entry.candidateCount} candidates · ${entry.status}`}
        />
      </div>

      <Card className="border border-border bg-surface shadow-none">
        <Card.Content className="grid min-h-[30rem] grid-cols-[17rem_minmax(0,1fr)] p-0 max-lg:grid-cols-1">
          <aside className="border-r border-border p-5 max-lg:border-b max-lg:border-r-0">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-medium text-foreground">{tr('run.summary')}</h2>
              <Chip color={generationStateColor(entry.status)} size="sm" variant="soft">
                {entry.status}
              </Chip>
            </div>
            <div className="grid gap-2">
              {[
                ['Evidence scope', 'Frozen'],
                ['Prepare evidence', entry.evidence ? 'Complete' : 'Unavailable'],
                ['Generate rules', `${entry.candidateCount} candidates`],
                ['Review & publish', `${acceptedCount} accepted · ${draftCount} draft`],
              ].map(([label, detail], index) => (
                <div
                  className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 rounded-lg px-2 py-3"
                  key={label}
                >
                  <span className="grid size-5 place-items-center rounded-full bg-surface-hover text-muted">
                    {index < 3 ? <Check aria-hidden="true" size={13} /> : <Circle aria-hidden="true" size={9} />}
                  </span>
                  <span className="grid gap-1">
                    <span className="font-medium text-foreground">{label}</span>
                    <span className="text-xs text-muted">{detail}</span>
                  </span>
                </div>
              ))}
            </div>
          </aside>

          <section className="min-w-0 p-5">
            <div className="mx-auto grid w-full max-w-3xl gap-6 py-3">
              <div className="flex justify-end">
                <div className="max-w-xl rounded-2xl rounded-tr-md bg-surface-hover px-4 py-3 text-sm leading-6 text-foreground">
                  Generate reusable rules from {generationHistoryScopeLabel(entry).toLowerCase()}.
                  Keep project-specific behavior scoped to its project.
                </div>
              </div>

              <article className="grid gap-4">
                <p className="leading-7 text-foreground">
                  This is the frozen, run-level Evidence and candidate record.
                </p>
                <div className="overflow-hidden rounded-xl border border-border bg-surface">
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                    <span>
                      <strong className="block text-sm font-medium text-foreground">
                        Historical Evidence snapshot
                      </strong>
                      <span className="mt-1 block text-xs text-muted">
                        One snapshot with projects preserved as source groups
                      </span>
                    </span>
                    <span className="text-xs text-muted">
                      {entry.evidence ? `${entry.evidence?.totalSessions ?? 0} sessions` : 'Legacy run'}
                    </span>
                  </div>
                  {entry.evidence && (
                    <>
                      <div className="grid grid-cols-3 border-t border-border max-sm:grid-cols-1">
                        <RunMetric label={tr('fields.projectGroups')} value={String(entry.evidence?.projectCount ?? 0)} />
                        <RunMetric label={tr('fields.sessions')} value={String(entry.evidence?.totalSessions ?? 0)} />
                        <RunMetric
                          label={tr('fields.redactedExcerpts')}
                          value={projects.length > 0 ? String(excerptCount) : 'Not recorded'}
                        />
                      </div>
                      {projects.length > 0 && (
                        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3.5">
                          {projects.map((project) => (
                            <Chip key={project.slug} size="sm" variant="soft">
                              {project.slug} · {project.sessionIds.length}
                            </Chip>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="grid gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="font-medium text-foreground">{tr('generated.candidates')}</h2>
                    <span className="text-xs text-muted">{entry.candidates.length} linked to this run</span>
                  </div>
                  {entry.candidates.length > 0 ? (
                    entry.candidates.map((candidate) => (
                      <button
                        className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-4 rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-hover"
                        key={candidate.id}
                        onClick={() => onReview(candidate)}
                        type="button"
                      >
                        <span>
                          <strong className="line-clamp-2 text-sm font-medium text-foreground">
                            {candidate.rule_text}
                          </strong>
                          <span className="mt-1 block text-xs text-muted">
                            {candidate.project_slug ?? 'Global'} · {candidate.confidence_level} confidence
                          </span>
                        </span>
                        <Chip
                          color={candidate.status === 'accepted'
                            ? 'success'
                            : candidate.status === 'rejected'
                              ? 'danger'
                              : 'default'}
                          size="sm"
                          variant="soft"
                        >
                          {candidate.status}
                        </Chip>
                      </button>
                    ))
                  ) : (
                    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
                      {entry.candidateCount === 0
                        ? 'No candidates were generated for this run.'
                        : 'Linked candidates are unavailable for this legacy run.'}
                    </div>
                  )}
                </div>
              </article>
            </div>
          </section>
        </Card.Content>
      </Card>
      </>)}
    </>
  )
}

function EvidenceCollectionView({
  active,
  generation,
}: {
  active: boolean
  generation: GenerationStatus
}) {
  const snapshot = generation.evidence
  const excerptCount = snapshot?.projects.reduce(
    (total, project) => total + project.excerptCount,
    0,
  ) ?? 0
  return (
    <div className="mx-auto grid min-h-[28rem] w-full max-w-3xl content-start gap-6 py-3">
      <div className="flex justify-end">
        <div className="max-w-xl rounded-2xl rounded-tr-md bg-surface-hover px-4 py-3 text-sm leading-6 text-foreground">
          {tr('evidence.request', { scope: generationScopeLabel(generation) })}
        </div>
      </div>
      <article className="grid gap-4">
        <p className="leading-7 text-foreground">
          {tr('evidence.preparing')}
        </p>
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
            <span>
              <strong className="block text-sm font-medium text-foreground">{tr('evidence.oneSnapshot')}</strong>
              <span className="mt-1 block text-xs text-muted">
                {tr('evidence.frozenBefore')}
              </span>
            </span>
            <span className="flex items-center gap-2 text-xs text-muted">
              {active && !snapshot && <Spinner color="accent" size="sm" />}
              {snapshot ? tr('counts.sessions', { count: snapshot.totalSessions }) : tr('status.preparing')}
            </span>
          </div>
          <div className="h-1 bg-surface-hover">
            <div className={`h-full bg-primary transition-all ${snapshot ? 'w-full' : 'w-2/3'}`} />
          </div>
          <div className="grid grid-cols-3 border-t border-border max-sm:grid-cols-1">
            <RunMetric
              label={tr('fields.projectGroups')}
              value={snapshot ? String(snapshot.projects.length) : tr('status.scanning')}
            />
            <RunMetric
              label={tr('fields.sessions')}
              value={snapshot ? String(snapshot.totalSessions) : tr('status.readingIndexes')}
            />
            <RunMetric
              label={tr('fields.redactedExcerpts')}
              value={snapshot ? String(excerptCount) : tr('status.normalizing')}
            />
          </div>
          {snapshot && (
            <div className="border-t border-border px-4 py-3.5">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                {tr('evidence.insideSnapshot')}
              </p>
              <div className="flex flex-wrap gap-2">
                {snapshot.projects.map((project) => (
                  <Chip key={project.slug} size="sm" variant="soft">
                    {project.slug} · {project.sessionIds.length}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted">
          {active && <Spinner color="accent" size="sm" />}
          {snapshot
            ? tr('evidence.ready')
            : tr('evidence.reading')}
        </div>
      </article>
    </div>
  )
}

function ProcessTimeline({
  active,
  generation,
}: {
  active: boolean
  generation: GenerationStatus
}) {
  return (
    <aside className="border-r border-border pr-4 max-xl:border-b max-xl:border-r-0 max-xl:pb-4">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">{tr('evidence.process')}</p>
      <div className="grid gap-3">
        <ProcessEvent
          active={!generation.evidence}
          detail={generation.evidence
            ? tr('counts.projectsFrozen', { count: generation.evidence.projects.length })
            : tr('evidence.collecting')}
          done={Boolean(generation.evidence)}
          title={tr('generate.prepareEvidence')}
        />
        {generation.projectResponses.map((response) => (
          <ProcessEvent
            detail={response.status === 'failed'
              ? response.error ?? response.summary
              : tr('counts.candidatesValidated', { count: response.candidates.length })}
            done={response.status !== 'failed'}
            key={response.projectSlug}
            title={response.projectSlug}
          />
        ))}
        {active && (
          <ProcessEvent
            active
            detail={generation.progress?.projectSlug
              ? tr('evidence.generating')
              : tr('evidence.waitingProject')}
            title={generation.progress?.projectSlug ?? tr('evidence.agentActivity')}
          />
        )}
      </div>
    </aside>
  )
}

function ProcessEvent({
  active = false,
  detail,
  done = false,
  title,
}: {
  active?: boolean
  detail: string
  done?: boolean
  title: string
}) {
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2">
      <span className={`mt-0.5 grid size-4 place-items-center rounded-full ${
        active ? 'bg-primary text-primary-foreground' : 'bg-surface-hover text-muted'
      }`}>
        {done ? <Check aria-hidden="true" size={11} /> : active ? <Sparkles aria-hidden="true" size={10} /> : <Circle aria-hidden="true" size={8} />}
      </span>
      <span className="grid gap-0.5">
        <strong className="truncate text-xs text-foreground">{title}</strong>
        <span className="text-xs leading-5 text-muted">{detail}</span>
      </span>
    </div>
  )
}

function ProjectResponseConversation({
  active,
  generation,
  onOpenCandidate,
}: {
  active: boolean
  generation: GenerationStatus
  onOpenCandidate: (
    projectSlug: string,
    candidate: ProjectGenerationCandidate,
  ) => void
}) {
  if (generation.projectResponses.length === 0 && !active) {
    return (
      <div className="grid min-h-64 place-items-center text-sm text-muted">
        {tr('evidence.emptyResponses')}
      </div>
    )
  }

  return (
    <div className="grid gap-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-foreground">{tr('evidence.agentOutput')}</p>
          <p className="text-xs text-muted">{tr('evidence.responseDescription')}</p>
        </div>
        {active && <Spinner aria-label={tr('evidence.working')} color="accent" size="sm" />}
      </header>
      {generation.projectResponses.map((response) => (
        <article className="grid gap-3" key={response.projectSlug}>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="grid size-6 place-items-center rounded-md bg-primary-soft font-semibold text-primary">
              A
            </span>
            <strong className="text-foreground">{response.projectSlug}</strong>
            <span>· {response.status === 'failed'
              ? tr('evidence.responseFailed')
              : tr('evidence.responseComplete')}</span>
          </div>
          <div className="rounded-bl-md rounded-br-xl rounded-tr-xl border border-border bg-surface p-4">
            <p className="text-sm leading-6 text-foreground">{response.summary}</p>
            {response.candidates.length > 0 && (
              <div className="mt-3 grid gap-2">
                {response.candidates.map((candidate, index) => (
                  <button
                    aria-label={tr('evidence.viewCandidate', { project: response.projectSlug })}
                    className="grid cursor-pointer gap-2 rounded-xl border border-border bg-surface-hover p-3 text-left transition-colors hover:border-primary focus-visible:border-primary focus-visible:outline-none"
                    key={`${response.projectSlug}:${index}:${candidate.rule}`}
                    onClick={() => onOpenCandidate(response.projectSlug, candidate)}
                    type="button"
                  >
                    <span className="flex items-center justify-between gap-3">
                      <strong className="text-sm text-foreground">
                        {tr('evidence.candidate', { index: index + 1 })}
                      </strong>
                      <ConfidenceChip level={candidate.confidence} />
                    </span>
                    <span className="line-clamp-2 text-xs leading-5 text-muted">
                      {candidate.rule}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </article>
      ))}
      {active && (
        <div className="flex items-center gap-3 rounded-xl bg-surface-hover p-3 text-xs text-muted">
          <Spinner color="accent" size="sm" />
          <span>
            {generation.progress?.projectSlug
              ? tr('evidence.generatingProject', { project: generation.progress.projectSlug })
              : tr('evidence.preparingProject')}
          </span>
        </div>
      )}
    </div>
  )
}

function CandidateDetailsModal({
  candidate,
  onClose,
  projectSlug,
}: {
  candidate: ProjectGenerationCandidate
  onClose: () => void
  projectSlug: string
}) {
  const evidence = useMemo(() => {
    const parsed = parseCandidateEvidence(JSON.stringify({
      reasoning: candidate.reasoning,
      evidence_refs: candidate.evidenceRefs,
    }), '[]')
    return {
      ...parsed,
      sourceSessions: [...new Set(parsed.references.map((reference) => reference.sessionId))],
    }
  }, [candidate.evidenceRefs, candidate.reasoning])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      aria-label={tr('evidence.candidateDetails')}
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4"
      role="dialog"
    >
      <Card className="w-full max-w-2xl border border-border bg-surface shadow-xl">
        <Card.Header className="flex items-start justify-between gap-4 border-b border-border">
          <div>
            <Card.Title>{tr('evidence.candidateDetails')}</Card.Title>
            <Card.Description>{tr('evidence.project', { project: projectSlug })}</Card.Description>
          </div>
          <Button
            aria-label={tr('actions.closeCandidate')}
            isIconOnly
            onPress={onClose}
            size="sm"
            variant="ghost"
          >
            <X aria-hidden="true" size={18} />
          </Button>
        </Card.Header>
        <Card.Content className="grid max-h-[70vh] gap-5 overflow-y-auto p-6 text-sm">
          <Detail label={tr('fields.rule')} value={candidate.rule} />
          <Detail label={tr('fields.scope')} value={candidate.scope} />
          <div>
            <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
              {tr('fields.confidence')}
            </span>
            <ConfidenceChip level={candidate.confidence} />
          </div>
          <Detail label={tr('fields.reasoning')} value={evidence.reasoning} />
          <EvidenceSourceContexts evidence={evidence} />
        </Card.Content>
      </Card>
    </div>
  )
}

function EvidenceExplorer({
  snapshot,
}: {
  snapshot: NonNullable<GenerationStatus['evidence']>
}) {
  const rowHeight = 58
  const viewportHeight = 348
  const overscan = 4
  const [query, setQuery] = useState('')
  const [selectedProjectSlug, setSelectedProjectSlug] = useState(
    snapshot.projects[0]?.slug ?? '',
  )
  const [scrollTop, setScrollTop] = useState(0)
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [preview, setPreview] = useState<SessionPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return snapshot.projects.filter((project) =>
      !normalized || project.slug.toLowerCase().includes(normalized),
    )
  }, [query, snapshot.projects])
  const selectedProject = snapshot.projects.find(
    (project) => project.slug === selectedProjectSlug,
  ) ?? snapshot.projects[0]
  const sessions = selectedProject?.sessionIds ?? []
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2
  const visibleSessions = sessions.slice(start, start + visibleCount)

  useEffect(() => {
    if (!selectedSession) {
      setPreview(null)
      return
    }
    let current = true
    setPreviewLoading(true)
    setPreviewError(null)
    void window.api.invoke<SessionPreview>('sessions.preview', selectedSession)
      .then((value) => {
        if (current) setPreview(value)
      })
      .catch((reason: unknown) => {
        if (current) {
          setPreviewError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (current) setPreviewLoading(false)
      })
    return () => {
      current = false
    }
  }, [selectedSession])

  const includedMessages = preview?.messages ?? []

  return (
    <div className="grid grid-cols-[minmax(14rem,0.38fr)_minmax(0,1fr)] gap-5 max-md:grid-cols-1">
      <div className="min-w-0">
        <label className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-background px-3">
          <Search aria-hidden="true" className="text-muted" size={16} />
          <input
            aria-label={tr('evidence.searchLabel')}
            className="h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr('evidence.searchPlaceholder')}
            value={query}
          />
        </label>
        <div className="max-h-[28rem] overflow-y-auto border-y border-border">
          {filteredProjects.map((project) => (
            <button
              aria-pressed={selectedProject?.slug === project.slug}
              className={`grid w-full cursor-pointer gap-1 border-b border-border px-3 py-3 text-left hover:bg-surface-hover ${
                selectedProject?.slug === project.slug ? 'bg-surface-hover' : ''
              }`}
              key={project.slug}
              onClick={() => {
                setSelectedProjectSlug(project.slug)
                setSelectedSession(null)
                setPreview(null)
                setScrollTop(0)
              }}
              type="button"
            >
              <strong className="truncate text-sm text-foreground">{project.slug}</strong>
              <span className="text-xs text-muted">
                {tr('counts.projectEvidence', {
                  sessions: project.sessionIds.length,
                  excerpts: project.excerptCount,
                })}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-w-0">
        {selectedProject ? (
          <div className="grid gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                {tr('evidence.projectEvidence')}
              </p>
              <h3 className="mt-1 text-xl font-semibold text-foreground">
                {selectedProject.slug}
              </h3>
              <p className="mt-1 text-xs text-muted">
                {tr('counts.roundEvidence', {
                  rounds: selectedProject.roundCount,
                  excerpts: selectedProject.excerptCount,
                })}
              </p>
            </div>
            <div
              className="overflow-y-auto border-y border-border"
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              style={{ height: viewportHeight }}
            >
              <div style={{ height: sessions.length * rowHeight, position: 'relative' }}>
                {visibleSessions.map((sessionId, index) => (
                  <button
                    aria-label={tr('evidence.openPreviewLabel', { session: sessionId })}
                    aria-pressed={selectedSession === sessionId}
                    className={`absolute left-0 grid w-full cursor-pointer gap-0.5 border-b border-border px-3 text-left hover:bg-surface-hover ${
                      selectedSession === sessionId ? 'bg-surface-hover' : ''
                    }`}
                    key={sessionId}
                    onClick={() => setSelectedSession(sessionId)}
                    style={{
                      height: rowHeight,
                      top: (start + index) * rowHeight,
                    }}
                    type="button"
                  >
                    <span className="truncate text-sm font-medium text-foreground">
                      {tr('evidence.openPreview')}
                    </span>
                    <code className="truncate text-xs text-muted">{sessionId}</code>
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted">{tr('counts.virtualSessions', { count: sessions.length })}</p>
          </div>
        ) : (
          <div className="grid min-h-[21.75rem] place-items-center rounded-xl bg-background text-sm text-muted">
            {tr('evidence.emptyProject')}
          </div>
        )}

        {previewLoading ? (
          <div className="grid min-h-[21.75rem] place-items-center">
            <Spinner aria-label={tr('evidence.loadingPreview')} color="accent" />
          </div>
        ) : previewError ? (
          <ErrorAlert message={previewError} title={tr('errors.loadEvidence')} />
        ) : preview && selectedSession ? (
          <div className="mt-4 grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{preview.displayName}</p>
                <p className="truncate font-mono text-xs text-muted">{preview.sessionId}</p>
              </div>
              <Chip size="sm" variant="soft">
                {tr('counts.messages', { count: includedMessages.length })}
              </Chip>
            </div>
            <div className="max-h-[19rem] overflow-y-auto rounded-xl bg-background p-4">
              <div className="grid gap-4">
                {includedMessages.map((message, index) => (
                  <div className="grid gap-1" key={`${message.role}:${index}`}>
                    <span className="text-xs font-medium capitalize text-muted">
                      {message.role}
                    </span>
                    {message.text && (
                      <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                        {message.text}
                      </p>
                    )}
                    {message.tools.length > 0 && (
                      <p className="text-xs text-muted">
                        {message.tools.map((tool) => `${tool.tool}: ${tool.summary}`).join(' · ')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : selectedProject ? (
          <p className="mt-4 text-xs text-muted">
            {tr('evidence.selectSession')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function ReviewRulePage({
  candidate,
  pendingAction,
  pendingEdit,
  error,
  onBack,
  onEdit,
  onUpdate,
}: {
  candidate: RuleCandidate
  pendingAction: RuleStatus | null
  pendingEdit: boolean
  error: string | null
  onBack: () => void
  onEdit: (ruleText: string) => void
  onUpdate: (status: 'accepted' | 'rejected') => void
}) {
  const evidence = useMemo(
    () => parseCandidateEvidence(candidate.evidence_json, candidate.source_sessions),
    [candidate.evidence_json, candidate.source_sessions],
  )
  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState(candidate.rule_text)

  useEffect(() => {
    setDraftText(candidate.rule_text)
    setEditing(false)
  }, [candidate.rule_text])

  return (
    <>
      <BackButton label={tr('actions.back')} onPress={onBack} />
      <PageHeader description={candidate.project_slug ?? candidate.scope} title={tr('review.title')} />
      {error && <div className="mb-4"><ErrorAlert message={error} title={tr('errors.updateRule')} /></div>}
      <div className="grid gap-4">
        <Card className="border border-border bg-surface shadow-none">
          <Card.Content className="grid gap-4 p-6">
            <div className="flex flex-wrap gap-2">
              <ConfidenceChip level={candidate.confidence_level} />
              <Chip size="sm" variant="soft">{tr(`status.${candidate.status}`, { defaultValue: candidate.status })}</Chip>
            </div>
            {editing ? (
              <textarea
                aria-label={tr('review.editLabel')}
                className="min-h-36 w-full resize-y rounded-xl border border-border bg-background p-4 text-sm leading-7 text-foreground outline-none focus:border-primary"
                onChange={(event) => setDraftText(event.currentTarget.value)}
                value={draftText}
              />
            ) : (
              <p className="text-lg leading-8 text-foreground">{candidate.rule_text}</p>
            )}
            {candidate.status === 'draft' && (
              <div className="flex justify-end gap-2">
                {editing ? (
                  <>
                    <Button
                      isDisabled={pendingEdit}
                      onPress={() => {
                        setDraftText(candidate.rule_text)
                        setEditing(false)
                      }}
                      variant="ghost"
                    >
                      {tr('actions.cancelEdit')}
                    </Button>
                    <Button
                      className="gap-2"
                      isDisabled={pendingEdit || !draftText.trim() || draftText.trim() === candidate.rule_text}
                      onPress={() => onEdit(draftText)}
                      variant="primary"
                    >
                      {pendingEdit ? <Spinner color="current" size="sm" /> : <Save aria-hidden="true" size={16} />}
                      {tr('actions.saveCandidate')}
                    </Button>
                  </>
                ) : (
                  <Button className="gap-2" onPress={() => setEditing(true)} variant="ghost">
                    <FilePenLine aria-hidden="true" size={16} />
                    {tr('actions.editCandidate')}
                  </Button>
                )}
              </div>
            )}
          </Card.Content>
        </Card>
        <Card className="border border-border bg-surface shadow-none">
          <Card.Header className="border-b border-border">
            <Card.Title className="text-base">{tr('review.evidenceSummary')}</Card.Title>
          </Card.Header>
          <Card.Content className="grid gap-4 p-6 text-sm">
            <Detail
              label={tr('fields.reasoning')}
              value={evidence.parseError ? tr('errors.parseEvidence') : evidence.reasoning}
            />
            <EvidenceSourceContexts evidence={evidence} />
          </Card.Content>
        </Card>
        {candidate.status === 'draft' && (
          <div className="flex justify-end gap-2">
            <Button
              isDisabled={pendingAction !== null}
              onPress={() => onUpdate('rejected')}
              variant="danger"
            >
              {pendingAction === 'rejected' ? <Spinner color="current" size="sm" /> : tr('actions.reject')}
            </Button>
            <Button
              isDisabled={pendingAction !== null}
              onPress={() => onUpdate('accepted')}
              variant="primary"
            >
              {pendingAction === 'accepted' ? <Spinner color="current" size="sm" /> : tr('actions.accept')}
            </Button>
          </div>
        )}
      </div>
    </>
  )
}

type EvidenceContextLoad =
  | { status: 'loading' }
  | { status: 'loaded'; context: SessionEvidenceContext }
  | { status: 'error'; message: string }

function EvidenceSourceContexts({ evidence }: { evidence: CandidateEvidence }) {
  const [loads, setLoads] = useState<Record<string, EvidenceContextLoad>>({})

  useEffect(() => {
    let current = true
    const initial = Object.fromEntries(
      evidence.references.map((reference) => [evidenceReferenceKey(reference), { status: 'loading' }]),
    ) as Record<string, EvidenceContextLoad>
    setLoads(initial)
    for (const reference of evidence.references) {
      const key = evidenceReferenceKey(reference)
      void window.api.invoke<SessionEvidenceContext>('sessions.evidenceContext', {
        sessionId: reference.sessionId,
        messageIndex: reference.messageIndex,
      }).then((context) => {
        if (current) {
          setLoads((previous) => ({ ...previous, [key]: { status: 'loaded', context } }))
        }
      }).catch((reason: unknown) => {
        if (current) {
          setLoads((previous) => ({
            ...previous,
            [key]: {
              status: 'error',
              message: reason instanceof Error ? reason.message : String(reason),
            },
          }))
        }
      })
    }
    return () => {
      current = false
    }
  }, [evidence.references])

  return (
    <section className="grid gap-3" data-evidence-source-contexts>
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
          {tr('review.sourceContext')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted">{tr('review.sourceContextDescription')}</p>
      </div>
      {evidence.references.length > 0 ? evidence.references.map((reference) => (
        <EvidenceSourceContext
          key={evidenceReferenceKey(reference)}
          load={loads[evidenceReferenceKey(reference)] ?? { status: 'loading' }}
          reference={reference}
        />
      )) : (
        <div className="rounded-xl border border-dashed border-border bg-background px-4 py-4">
          <p className="text-sm text-muted">{tr('review.noSourceContext')}</p>
          {evidence.sourceSessions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {evidence.sourceSessions.map((sessionId) => (
                <Chip key={sessionId} size="sm" variant="soft">{sessionId}</Chip>
              ))}
            </div>
          )}
        </div>
      )}
      {evidence.invalidReferenceCount > 0 && (
        <p className="text-xs text-warning">
          {tr('review.invalidReferences', { count: evidence.invalidReferenceCount })}
        </p>
      )}
    </section>
  )
}

function EvidenceSourceContext({
  reference,
  load,
}: {
  reference: EvidenceReference
  load: EvidenceContextLoad
}) {
  const agent = load.status === 'loaded' ? load.context.agent : reference.agent
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-background">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          {load.status === 'loaded' && (
            <p className="mb-2 truncate text-sm font-medium text-foreground">
              {load.context.displayName}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {agent && <Chip size="sm" variant="soft">{agent}</Chip>}
            {reference.timestamp && (
              <span className="text-xs text-muted">{formatEvidenceTimestamp(reference.timestamp)}</span>
            )}
          </div>
          <p className="mt-2 break-all font-mono text-xs text-muted">{reference.sessionId}</p>
        </div>
        <span className="text-xs text-muted">{tr('review.messageIndex', { index: reference.messageIndex })}</span>
      </header>
      {load.status === 'loading' ? (
        <div className="flex items-center gap-2 px-4 py-5 text-sm text-muted">
          <Spinner size="sm" />
          {tr('review.loadingContext')}
        </div>
      ) : load.status === 'error' ? (
        <div className="px-4 py-4">
          <p className="text-sm font-medium text-danger">{tr('review.contextUnavailable')}</p>
          <p className="mt-1 break-words text-xs leading-5 text-muted">{load.message}</p>
        </div>
      ) : (
        <>
          {load.context.eligibility !== 'eligible' && (
            <div className="border-b border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
              {load.context.eligibility === 'existing_rule_baseline'
                ? tr('review.existingRuleBaselineDescription')
                : tr('review.platformContextDescription')}
            </div>
          )}
          <ol className="divide-y divide-border">
          {load.context.messages.map((message) => (
            <li
              className={`grid gap-2 px-4 py-3 ${evidenceMessageClass(
                message.matched,
                load.context.eligibility,
              )}`}
              key={message.messageIndex}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted">
                  {tr(`review.roles.${message.role}`)}
                </span>
                {message.matched && load.context.eligibility === 'eligible' && (
                  <Chip color="accent" size="sm" variant="soft">{tr('review.evidenceHit')}</Chip>
                )}
                {message.matched && load.context.eligibility === 'existing_rule_baseline' && (
                  <Chip color="warning" size="sm" variant="soft">
                    {tr('review.existingRuleBaseline')}
                  </Chip>
                )}
                {message.matched && load.context.eligibility === 'platform_context' && (
                  <Chip color="warning" size="sm" variant="soft">
                    {tr('review.excludedPlatformContext')}
                  </Chip>
                )}
              </div>
              {message.text && (
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                  {message.text}
                </p>
              )}
              {message.tools.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {message.tools.map((tool, index) => (
                    <Chip key={`${tool.tool}-${index}`} size="sm" variant="soft">
                      {tool.tool} · {tool.summary}
                    </Chip>
                  ))}
                </div>
              )}
            </li>
          ))}
          </ol>
        </>
      )}
    </article>
  )
}

function evidenceMessageClass(
  matched: boolean,
  eligibility: SessionEvidenceContext['eligibility'],
): string {
  if (!matched) return ''
  return eligibility === 'eligible'
    ? 'border-l-2 border-l-primary bg-primary/5'
    : 'border-l-2 border-l-warning bg-warning/5'
}

function evidenceReferenceKey(reference: EvidenceReference): string {
  return `${reference.sessionId}:${reference.messageIndex}`
}

function formatEvidenceTimestamp(value: string): string {
  const normalized = /^\d+$/.test(value) ? Number(value) : value
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date, currentLocale())
}

function OutputRulesPage({
  initialProjectSlug,
  onBack,
}: {
  initialProjectSlug?: string | null
  onBack: () => void
}) {
  const [publishTab, setPublishTab] = useState<'project' | 'global' | 'memory'>('project')
  const [memoryProvider, setMemoryProvider] = useState<'claude' | 'codex'>('claude')
  const [accepted, setAccepted] = useState<RuleCandidate[]>([])
  const [targets, setTargets] = useState<GlobalInstructionReadResult[]>([])
  const [memoryTargets, setMemoryTargets] = useState<ClaudeProjectMemoryPublishTarget[]>([])
  const [codexMemoryTargets, setCodexMemoryTargets] = useState<CodexProjectMemoryPublishTarget[]>([])
  const [selectedAgents, setSelectedAgents] = useState<GlobalInstructionAgent[]>([])
  const [selectedProjectSlug, setSelectedProjectSlug] =
    useState<string | null>(initialProjectSlug ?? null)
  const [selectedProjectRuleIds, setSelectedProjectRuleIds] = useState<string[]>([])
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null)
  const [selectedCodexWorkingDirectory, setSelectedCodexWorkingDirectory] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [memoryPublishing, setMemoryPublishing] = useState(false)
  const [codexMemoryPublishing, setCodexMemoryPublishing] = useState(false)
  const [codexTargetsLoading, setCodexTargetsLoading] = useState(false)
  const [outputting, setOutputting] = useState(false)
  const [paths, setPaths] = useState<string[]>([])
  const [publishResult, setPublishResult] = useState<AgentInstructionPublishSummary | null>(null)
  const [memoryPublishResult, setMemoryPublishResult] = useState<ClaudeProjectMemoryPublishResult | null>(null)
  const [codexMemoryPublishResult, setCodexMemoryPublishResult] = useState<CodexProjectMemoryPublishResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void afterNextPaint(async () => {
      const [rows, instructionResult, projectMemoryTargets] = await Promise.all([
        window.api.invoke<RuleCandidate[]>('rules.candidates', 'accepted'),
        window.api.invoke<GlobalInstructionListResult>('rules.instructions.list'),
        window.api.invoke<ClaudeProjectMemoryPublishTarget[]>('rules.memories.publishTargets'),
      ])
      const instructionTargets = await Promise.all(
        instructionResult.sources.map((source) =>
          window.api.invoke<GlobalInstructionReadResult>(
            'rules.instructions.read',
            source.agent,
          ),
        ),
      )
      return { rows, instructionTargets, projectMemoryTargets }
    })
      .then(({ rows, instructionTargets, projectMemoryTargets }) => {
        if (!current) return
        setAccepted(rows)
        setTargets(instructionTargets)
        setMemoryTargets(projectMemoryTargets)
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [])

  useEffect(() => {
    let current = true
    setSelectedCodexWorkingDirectory(null)
    setCodexMemoryPublishResult(null)
    if (!selectedProjectSlug) {
      setCodexMemoryTargets([])
      setCodexTargetsLoading(false)
      return
    }
    setCodexMemoryTargets([])
    setCodexTargetsLoading(true)
    setError(null)
    void afterNextPaint(() =>
      window.api.invoke<CodexProjectMemoryPublishTarget[]>(
        'rules.memories.codexProjectTargets',
        selectedProjectSlug,
      ))
      .then((result) => {
        if (current) setCodexMemoryTargets(result)
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (current) setCodexTargetsLoading(false)
      })
    return () => {
      current = false
    }
  }, [selectedProjectSlug])

  const globalRules = useMemo(
    () => accepted.filter((candidate) => candidate.scope === 'global'),
    [accepted],
  )
  const projectRules = useMemo(
    () => accepted.filter((candidate) => candidate.scope === 'project'),
    [accepted],
  )
  const hasNoGlobalRules = publishTab === 'global' && globalRules.length === 0
  const projectSlugs = useMemo(
    () => [...new Set(projectRules.flatMap((candidate) =>
      candidate.project_slug ? [candidate.project_slug] : []))].sort((left, right) =>
      left.localeCompare(right, currentLocale())),
    [projectRules],
  )

  useEffect(() => {
    if (projectSlugs.length === 1 && selectedProjectSlug !== projectSlugs[0]) {
      selectProject(projectSlugs[0])
      return
    }
    if (selectedProjectSlug && !projectSlugs.includes(selectedProjectSlug)) {
      selectProject(null)
    }
  }, [projectSlugs, selectedProjectSlug])

  useEffect(() => {
    if (!initialProjectSlug) return
    const initialRules = projectRules.filter(
      (candidate) => candidate.project_slug === initialProjectSlug,
    )
    if (initialRules.length === 0) return
    setSelectedProjectSlug(initialProjectSlug)
    setSelectedProjectRuleIds(initialRules.map((candidate) => candidate.id))
  }, [initialProjectSlug, projectRules])

  const selectedProjectRules = projectRules.filter(
    (candidate) => candidate.project_slug === selectedProjectSlug,
  )
  const selectedMemoryTarget = memoryTargets.find(
    (target) => target.memoryId === selectedMemoryId,
  )
  const selectedCodexMemoryTarget = codexMemoryTargets.find(
    (target) => target.workingDirectory === selectedCodexWorkingDirectory,
  )

  function toggleAgent(agent: GlobalInstructionAgent): void {
    setSelectedAgents((current) =>
      current.includes(agent)
        ? current.filter((item) => item !== agent)
        : [...current, agent],
    )
    setPublishResult(null)
  }

  function selectProject(projectSlug: string | null): void {
    setSelectedProjectSlug(projectSlug)
    setSelectedProjectRuleIds(projectSlug
      ? projectRules
        .filter((candidate) => candidate.project_slug === projectSlug)
        .map((candidate) => candidate.id)
      : [])
    setMemoryPublishResult(null)
    setCodexMemoryPublishResult(null)
  }

  function toggleProjectRule(ruleId: string): void {
    setSelectedProjectRuleIds((current) => current.includes(ruleId)
      ? current.filter((id) => id !== ruleId)
      : [...current, ruleId])
    setMemoryPublishResult(null)
    setCodexMemoryPublishResult(null)
  }

  async function publishProjectMemory(): Promise<void> {
    if (!selectedMemoryTarget || selectedProjectRuleIds.length === 0) return
    setMemoryPublishing(true)
    setMemoryPublishResult(null)
    setError(null)
    try {
      const result = await afterNextPaint(() =>
        window.api.invoke<ClaudeProjectMemoryPublishResult>(
          'rules.memories.publishProjectRules',
          {
            memoryId: selectedMemoryTarget.memoryId,
            ruleIds: selectedProjectRuleIds,
            expectedRevision: selectedMemoryTarget.revision,
            expectedTopicRevision: selectedMemoryTarget.topicRevision,
          },
        ),
      )
      setMemoryPublishResult(result)
      setMemoryTargets((current) => current.map((target) =>
        target.memoryId === result.memoryId
          ? {
              ...target,
              revision: result.revision,
              topicRevision: result.topicRevision,
            }
          : target))
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setMemoryPublishing(false)
    }
  }

  async function publishCodexProjectMemory(): Promise<void> {
    if (!selectedCodexMemoryTarget || selectedProjectRuleIds.length === 0) return
    setCodexMemoryPublishing(true)
    setCodexMemoryPublishResult(null)
    setError(null)
    try {
      const result = await afterNextPaint(() =>
        window.api.invoke<CodexProjectMemoryPublishResult>(
          'rules.memories.publishCodexProjectRules',
          {
            projectSlug: selectedCodexMemoryTarget.projectSlug,
            workingDirectory: selectedCodexMemoryTarget.workingDirectory,
            ruleIds: selectedProjectRuleIds,
            expectedRevision: selectedCodexMemoryTarget.revision,
            expectedContractRevision: selectedCodexMemoryTarget.contractRevision,
          },
        ),
      )
      setCodexMemoryPublishResult(result)
      setCodexMemoryTargets((current) => current.map((target) =>
        target.workingDirectory === result.workingDirectory
          ? {
              ...target,
              revision: result.revision,
              contractRevision: result.contractRevision,
            }
          : target))
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCodexMemoryPublishing(false)
    }
  }

  async function publish(): Promise<void> {
    if (selectedAgents.length === 0) return
    setPublishing(true)
    setPublishResult(null)
    setError(null)
    try {
      const result = await afterNextPaint(() =>
        window.api.invoke<AgentInstructionPublishSummary>(
          'rules.publishAgents',
          selectedAgents.map((agent) => {
            const target = targets.find((item) => item.source.agent === agent)
            return {
              agent,
              expectedRevision: target?.revision ?? null,
            }
          }),
        ),
      )
      setPublishResult(result)
      setTargets((current) => current.map((target) => {
        const published = result.results.find(
          (item) => item.agent === target.source.agent && item.revision,
        )
        return published?.revision
          ? {
              ...target,
              revision: published.revision,
              source: { ...target.source, status: 'present', effective: true },
            }
          : target
      }))
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPublishing(false)
    }
  }

  async function exportProjectRules(): Promise<void> {
    if (!selectedProjectSlug) return
    setOutputting(true)
    setPaths([])
    setError(null)
    try {
      const outputPaths = await afterNextPaint(() =>
        window.api.invoke<string[]>('rules.output', selectedProjectSlug))
      setPaths(outputPaths)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setOutputting(false)
    }
  }

  return (
    <PageShell
      archetype="task"
      className="min-h-[calc(100dvh-6rem)] !gap-3"
      density="compact"
      width="wide"
    >
      <PageHeader
        actions={(
          <Button className="gap-2 text-muted" onPress={onBack} size="sm" variant="ghost">
            <ArrowLeft aria-hidden="true" size={16} />
            {tr('actions.back')}
          </Button>
        )}
        className="mb-0"
        description={tr('publish.description')}
        title={tr('publish.title')}
      />
      <nav
        aria-label={tr('publish.tabsLabel')}
        className="grid w-full max-w-[28rem] grid-cols-3 gap-1 rounded-xl border border-border bg-background p-1"
        data-publish-tabs="true"
      >
        {(['project', 'memory', 'global'] as const).map((tab) => {
          const count = tab === 'global' ? globalRules.length : projectRules.length
          const selected = publishTab === tab
          return (
            <button
              aria-selected={selected}
              className={`flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors ${
                selected
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-muted hover:bg-surface-hover hover:text-foreground'
              }`}
              data-publish-tab={tab}
              key={tab}
              onClick={() => setPublishTab(tab)}
              role="tab"
              type="button"
            >
              {tr(`publish.tabs.${tab}`)}
              <span className={`min-w-5 rounded-md px-1.5 py-0.5 text-xs tabular-nums ${selected ? 'bg-primary-soft text-primary' : 'bg-surface-hover text-muted'}`}>
                {count}
              </span>
            </button>
          )
        })}
      </nav>
      {loading ? (
        <ViewLoading label={tr('publish.loading')} />
      ) : (
        <div
          className={`grid min-h-[calc(100dvh-13rem)] min-w-0 items-stretch overflow-hidden rounded-xl border border-border bg-surface ${hasNoGlobalRules ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_22rem] max-xl:grid-cols-1'}`}
          data-publish-workbench="true"
        >
          <div className="min-w-0" data-publish-rules-pane="true">
            <Card className="h-full min-w-0 rounded-none border-0 bg-surface shadow-none">
              <Card.Header className="block border-b border-border px-4 py-3">
                <div className="flex w-full items-center justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="truncate font-medium text-foreground">
                      {publishTab === 'global'
                        ? tr('publish.globalRules')
                        : selectedProjectSlug ?? tr('publish.projectRules')}
                    </h2>
                    <p className="mt-0.5 text-xs text-muted">
                      {tr('publish.workbenchSummary', {
                        count: publishTab === 'global' ? globalRules.length : selectedProjectRules.length,
                      })}
                    </p>
                  </div>
                  {publishTab !== 'global' && (
                    <Button
                      className="shrink-0 gap-2"
                      isDisabled={!selectedProjectSlug || outputting}
                      onPress={() => void exportProjectRules()}
                      size="sm"
                      variant="ghost"
                    >
                      {outputting ? <Spinner color="current" size="sm" /> : <FileOutput aria-hidden="true" size={16} />}
                      {tr('actions.writeProjectOutput')}
                    </Button>
                  )}
                </div>
              </Card.Header>
              <Card.Content className="p-0">
                {publishTab === 'global' && (
                <div className={globalRules.length === 0 ? 'grid min-h-[calc(100dvh-20rem)] place-items-center px-4 py-8 text-center' : 'px-4 py-4'}>
                  {globalRules.length === 0 ? (
                    <div className="max-w-sm">
                      <span className="mx-auto grid size-10 place-items-center rounded-full bg-background text-sm font-medium text-muted">0</span>
                      <h3 className="mt-3 text-sm font-medium text-foreground">{tr('publish.emptyGlobalTitle')}</h3>
                      <p className="mt-1 text-sm leading-6 text-muted">{tr('publish.emptyGlobal')}</p>
                    </div>
                  ) : (
                  <>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-foreground">{tr('publish.globalRules')}</h3>
                    <Chip size="sm" variant="soft">{globalRules.length}</Chip>
                  </div>
                  <ul className="grid gap-2">
                    {globalRules.map((candidate) => (
                      <li className="rounded-lg bg-background px-3 py-2.5 text-sm leading-6 text-foreground" key={candidate.id}>
                        {candidate.rule_text}
                      </li>
                    ))}
                  </ul>
                  </>
                  )}
                </div>
                )}
                {publishTab !== 'global' && (
                <div className="px-4 py-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium text-foreground">{tr('publish.selectRules')}</h3>
                      <p className="mt-1 text-xs leading-5 text-muted">{tr('publish.selectionHelp')}</p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted">
                      {tr('publish.selectionSummary', {
                        selected: selectedProjectRuleIds.length,
                        total: selectedProjectRules.length,
                      })}
                    </span>
                  </div>
                  {projectSlugs.length > 1 && (
                    <Select
                      aria-label={tr('publish.projectSelect')}
                      className="mb-3 max-w-md"
                      onSelectionChange={(key) => selectProject(String(key))}
                      placeholder={tr('publish.projectSelectPlaceholder')}
                      selectedKey={selectedProjectSlug}
                    >
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {projectSlugs.map((slug) => (
                            <ListBox.Item id={slug} key={slug} textValue={slug}>{slug}</ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  )}
                  {selectedProjectSlug && (
                    <div className="mt-3 overflow-hidden rounded-xl border border-border">
                      {selectedProjectRules.map((candidate) => (
                        <label
                          className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-3 border-b border-border px-3 py-3 last:border-b-0 hover:bg-surface-hover"
                          key={candidate.id}
                        >
                          <input
                            checked={selectedProjectRuleIds.includes(candidate.id)}
                            className="mt-1 size-4 accent-primary"
                            onChange={() => toggleProjectRule(candidate.id)}
                            type="checkbox"
                          />
                          <span className="text-sm leading-6 text-foreground">
                            {candidate.rule_text}
                            <span className="mt-1 block text-xs text-muted">
                              {tr('publish.projectRuleMeta', { project: candidate.project_slug })}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                )}
              </Card.Content>
            </Card>
            {paths.length > 0 && (
              <Alert status="success">
                <Alert.Content>
                  <Alert.Title>{tr('publish.projectOutputComplete')}</Alert.Title>
                  <Alert.Description>
                    {tr('publish.projectOutputPath', { path: paths[0] })}
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            )}
          </div>

          {!hasNoGlobalRules && (
          <aside className="min-w-0 border-l border-border max-xl:border-l-0 max-xl:border-t" data-publish-target-pane="true">
            {publishTab !== 'memory' && (
            <Card className="min-w-0 overflow-hidden rounded-none border-0 bg-surface shadow-none">
              <Card.Header className="border-b border-border px-4 py-3">
                <div>
                  <h2 className="font-medium text-foreground">{tr('publish.targets')}</h2>
                  <p className="mt-1 text-sm text-muted">{tr('publish.noDefault')}</p>
                </div>
              </Card.Header>
              <Card.Content className="p-0">
                {targets.map((target) => {
                  const selected = selectedAgents.includes(target.source.agent)
                  return (
                    <label
                      className="grid cursor-pointer grid-cols-[auto_2.25rem_minmax(0,1fr)] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-surface-hover"
                      key={target.source.agent}
                    >
                      <input
                        checked={selected}
                        className="size-4 accent-primary"
                        onChange={() => toggleAgent(target.source.agent)}
                        type="checkbox"
                      />
                      <span className="grid size-9 place-items-center rounded-lg bg-surface-hover text-xs font-medium text-foreground">
                        {instructionAgentInitial(target.source.agent)}
                      </span>
                      <span className="min-w-0">
                        <strong className="block text-sm font-medium text-foreground">
                          {instructionAgentLabel(target.source.agent)}
                        </strong>
                        <code className="mt-1 block truncate text-xs text-muted">
                          {target.source.path}
                        </code>
                        {target.source.status === 'missing' && (
                          <span className="mt-1 block text-xs text-warning">{tr('publish.fileCreated')}</span>
                        )}
                      </span>
                    </label>
                  )
                })}
              </Card.Content>
            </Card>
            )}

            {publishTab === 'memory' && (
            <Card
              className="min-w-0 overflow-hidden rounded-none border-0 bg-surface shadow-none"
              data-project-memory-targets
            >
              <Card.Header className="border-b border-border px-4 py-3">
                <div>
                  <h2 className="font-medium text-foreground">{tr('publish.projectMemoryTargetsTitle')}</h2>
                  <p className="mt-1 text-sm text-muted">{tr('publish.projectMemoryTargetsDescription')}</p>
                </div>
              </Card.Header>
              <Card.Content className="p-0">
                <div className="grid grid-cols-2 gap-1 bg-background p-1.5" role="tablist">
                  {(['claude', 'codex'] as const).map((provider) => (
                    <button
                      aria-selected={memoryProvider === provider}
                      className={`h-9 rounded-lg text-sm font-medium transition-colors ${memoryProvider === provider ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-foreground'}`}
                      data-memory-provider={provider}
                      key={provider}
                      onClick={() => setMemoryProvider(provider)}
                      role="tab"
                      type="button"
                    >
                      {provider === 'claude' ? 'Claude' : 'Codex'}
                    </button>
                  ))}
                </div>
                {memoryProvider === 'claude' && (
                <section className="grid gap-3 px-4 py-4">
                  <div>
                    <h3 className="text-sm font-medium text-foreground">{tr('publish.projectMemoryTitle')}</h3>
                    <p className="mt-1 text-xs leading-5 text-muted">{tr('publish.projectMemoryDescription')}</p>
                  </div>
                  <Select
                    aria-label={tr('publish.memoryTargetSelect')}
                    className="min-w-0"
                    onSelectionChange={(key) => {
                      const value = String(key)
                      setSelectedMemoryId(value === NO_SELECTION_KEY ? null : value)
                      setMemoryPublishResult(null)
                    }}
                    selectedKey={selectedMemoryId ?? NO_SELECTION_KEY}
                  >
                    <Select.Trigger className="min-w-0 overflow-hidden">
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        <ListBox.Item id={NO_SELECTION_KEY} textValue={tr('publish.memoryTargetPlaceholder')}>
                          {tr('publish.memoryTargetPlaceholder')}
                        </ListBox.Item>
                        {memoryTargets.map((target) => (
                          <ListBox.Item
                            id={target.memoryId}
                            isDisabled={!target.writable}
                            key={target.memoryId}
                            textValue={target.displayName}
                          >
                            <span className="block font-medium">{target.displayName}</span>
                            <span className="mt-0.5 block max-w-72 truncate text-xs text-muted">
                              {target.reason ?? target.path}
                            </span>
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                  <p className="text-xs leading-5 text-muted">
                    {tr('publish.projectMemorySelection', { count: selectedProjectRuleIds.length })}
                  </p>
                </section>
                )}

                {memoryProvider === 'codex' && (
                <section className="grid gap-3 border-t border-border px-4 py-4">
                  <div>
                    <h3 className="text-sm font-medium text-foreground">{tr('publish.codexProjectMemoryTitle')}</h3>
                    <p className="mt-1 text-xs leading-5 text-muted">{tr('publish.codexProjectMemoryDescription')}</p>
                  </div>
                  <Select
                    aria-label={tr('publish.codexWorkingDirectorySelect')}
                    className="min-w-0"
                    isDisabled={!selectedProjectSlug || codexTargetsLoading}
                    onSelectionChange={(key) => {
                      const value = String(key)
                      setSelectedCodexWorkingDirectory(
                        value === NO_SELECTION_KEY ? null : value,
                      )
                      setCodexMemoryPublishResult(null)
                    }}
                    selectedKey={selectedCodexWorkingDirectory ?? NO_SELECTION_KEY}
                  >
                    <Select.Trigger className="min-w-0 overflow-hidden">
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        <ListBox.Item
                          id={NO_SELECTION_KEY}
                          textValue={tr('publish.codexWorkingDirectoryPlaceholder')}
                        >
                          {tr('publish.codexWorkingDirectoryPlaceholder')}
                        </ListBox.Item>
                        {codexMemoryTargets.map((target) => (
                          <ListBox.Item
                            id={target.workingDirectory}
                            isDisabled={!target.writable}
                            key={target.workingDirectory}
                            textValue={target.workingDirectory}
                          >
                            <code className="block truncate text-sm">{target.workingDirectory}</code>
                            <span className="mt-0.5 block max-w-72 truncate text-xs text-muted">
                              {target.reason ?? tr('publish.codexWorkingDirectorySource', {
                                agents: target.agents.join(' · '),
                                count: target.sessionCount,
                              })}
                            </span>
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                  {codexTargetsLoading && (
                    <span className="flex items-center gap-2 text-xs text-muted">
                      <Spinner size="sm" />
                      {tr('publish.codexTargetsLoading')}
                    </span>
                  )}
                  {!codexTargetsLoading && selectedProjectSlug && codexMemoryTargets.length === 0 && (
                    <p className="text-xs leading-5 text-warning">{tr('publish.codexTargetsEmpty')}</p>
                  )}
                  {!codexTargetsLoading && (!selectedProjectSlug || codexMemoryTargets.length > 0) && (
                    <p className="text-xs leading-5 text-muted">
                      {tr('publish.codexProjectMemorySelection', {
                        count: selectedProjectRuleIds.length,
                      })}
                    </p>
                  )}
                </section>
                )}
              </Card.Content>
            </Card>
            )}

            {error && <ErrorAlert message={error} title={tr('errors.publish')} />}
            {memoryPublishResult && (
              <Alert status="success">
                <Alert.Content>
                  <Alert.Title>{tr(`publish.projectMemoryStatus.${memoryPublishResult.status}`)}</Alert.Title>
                  <Alert.Description>
                    {tr('publish.projectMemoryComplete', {
                      project: memoryPublishResult.projectSlug,
                      count: memoryPublishResult.ruleCount,
                    })}
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            )}
            {codexMemoryPublishResult && (
              <Alert status="success">
                <Alert.Content>
                  <Alert.Title>
                    {tr(`publish.codexProjectMemoryStatus.${codexMemoryPublishResult.status}`)}
                  </Alert.Title>
                  <Alert.Description>
                    {tr('publish.codexProjectMemoryComplete', {
                      project: codexMemoryPublishResult.projectSlug,
                      count: codexMemoryPublishResult.ruleCount,
                    })}
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            )}
            {publishResult && (
              <Card className="border border-border bg-surface shadow-none">
                <Card.Header className="border-b border-border px-4 py-3">
                  <h2 className="text-sm font-medium text-foreground">{tr('publish.results')}</h2>
                </Card.Header>
                <Card.Content className="p-0">
                  {publishResult.results.map((result) => (
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border px-4 py-3 last:border-b-0" key={result.agent}>
                      <span className="min-w-0">
                        <strong className="block text-sm font-medium text-foreground">
                          {instructionAgentLabel(result.agent)}
                        </strong>
                        <span className="mt-1 block break-words text-xs text-muted">
                          {result.message ?? result.path}
                        </span>
                      </span>
                      <Chip
                        color={result.status === 'failed' ? 'danger' : 'success'}
                        size="sm"
                        variant="soft"
                      >
                        {i18n.t(`common:status.${result.status}`, { defaultValue: result.status })}
                      </Chip>
                    </div>
                  ))}
                </Card.Content>
              </Card>
            )}
          </aside>
          )}
          {!hasNoGlobalRules && (
          <footer
            className="col-span-full flex min-w-0 items-center justify-between gap-4 border-t border-border bg-background px-4 py-3 max-sm:flex-col max-sm:items-stretch"
            data-publish-footer="true"
          >
            <div className="min-w-0">
              <strong className="block text-sm font-medium text-foreground">
                {tr('publish.selectedRules', {
                  count: publishTab === 'global' ? globalRules.length : selectedProjectRuleIds.length,
                })}
              </strong>
              <span className="mt-0.5 block truncate text-xs text-muted">
                {publishTab === 'memory'
                  ? tr(`publish.footer.${memoryProvider}`)
                  : tr('publish.footer.agents', { count: selectedAgents.length })}
              </span>
            </div>
            {publishTab === 'memory' ? (
              memoryProvider === 'claude' ? (
                <Button
                  className="shrink-0 gap-2 bg-primary text-primary-foreground"
                  data-primary-publish-action="true"
                  isDisabled={!selectedMemoryTarget?.writable || selectedProjectRuleIds.length === 0 || memoryPublishing}
                  onPress={() => void publishProjectMemory()}
                >
                  {memoryPublishing ? <Spinner color="current" size="sm" /> : <Brain aria-hidden="true" size={16} />}
                  {memoryPublishing
                    ? tr('actions.publishing')
                    : tr('actions.publishProjectMemory', { count: selectedProjectRuleIds.length })}
                </Button>
              ) : (
                <Button
                  className="shrink-0 gap-2 bg-primary text-primary-foreground"
                  data-primary-publish-action="true"
                  isDisabled={!selectedCodexMemoryTarget?.writable || selectedProjectRuleIds.length === 0 || codexMemoryPublishing}
                  onPress={() => void publishCodexProjectMemory()}
                >
                  {codexMemoryPublishing ? <Spinner color="current" size="sm" /> : <Terminal aria-hidden="true" size={16} />}
                  {codexMemoryPublishing
                    ? tr('actions.publishing')
                    : tr('actions.publishCodexProjectMemory', { count: selectedProjectRuleIds.length })}
                </Button>
              )
            ) : (
              <Button
                className="shrink-0 gap-2 bg-primary text-primary-foreground"
                data-primary-publish-action="true"
                isDisabled={globalRules.length === 0 || selectedAgents.length === 0 || publishing}
                onPress={() => void publish()}
              >
                {publishing ? <Spinner color="current" size="sm" /> : <Save aria-hidden="true" size={16} />}
                {publishing
                  ? tr('actions.publishing')
                  : tr('actions.publishAgents', { count: selectedAgents.length })}
              </Button>
            )}
          </footer>
          )}
        </div>
      )}
    </PageShell>
  )
}

type GenerationEventMetadata = {
  runId?: string
  seq?: number
  at?: string
}

type GenerationPhaseView = {
  key: GenerationPhaseKey
  label: string
  detail: string
  status: 'pending' | 'active' | 'done'
}

function eventMetadata(value: unknown): GenerationEventMetadata {
  if (!value || typeof value !== 'object') return {}
  const candidate = value as Record<string, unknown>
  return {
    ...(typeof candidate.runId === 'string' ? { runId: candidate.runId } : {}),
    ...(typeof candidate.seq === 'number' ? { seq: candidate.seq } : {}),
    ...(typeof candidate.at === 'string' ? { at: candidate.at } : {}),
  }
}

function ensureGeneration(
  current: GenerationStatus | null,
  metadata: GenerationEventMetadata,
): GenerationStatus {
  if (current && (!metadata.runId || current.runId === metadata.runId)) return current
  return {
    running: true,
    state: 'running',
    runId: metadata.runId,
    lastSeq: 0,
    projectResponses: [],
    events: [],
    output: '',
    outputTruncated: false,
    startedAt: metadata.at ?? new Date().toISOString(),
  }
}

function mergeGenerationProgress(
  current: GenerationStatus | null,
  progress: GenerateProgress,
  metadata: GenerationEventMetadata,
): GenerationStatus {
  const generation = ensureGeneration(current, metadata)
  if (
    metadata.seq !== undefined
    && generation.runId === metadata.runId
    && metadata.seq <= generation.lastSeq
  ) {
    return generation
  }
  return {
    ...generation,
    running: true,
    state: generation.state === 'cancelling' ? 'cancelling' : 'running',
    progress,
    lastSeq: Math.max(generation.lastSeq, metadata.seq ?? 0),
  }
}

function isGenerationEventEnvelope(value: unknown): value is GenerationEventEnvelope {
  if (!value || typeof value !== 'object') return false
  const envelope = value as Partial<GenerationEventEnvelope>
  if (
    envelope.type !== 'event'
    || typeof envelope.runId !== 'string'
    || typeof envelope.seq !== 'number'
    || typeof envelope.at !== 'string'
    || !envelope.event
    || typeof envelope.event !== 'object'
  ) {
    return false
  }
  const kind = (envelope.event as { kind?: unknown }).kind
  return ['assistant_delta', 'retry', 'phase', 'candidate_count', 'evidence_ready', 'project_response']
    .includes(String(kind))
}

function mergeGenerationEvent(
  current: GenerationStatus | null,
  envelope: GenerationEventEnvelope,
): GenerationStatus {
  const generation = ensureGeneration(current, envelope)
  if (generation.runId === envelope.runId && envelope.seq <= generation.lastSeq) {
    return generation
  }

  if (envelope.event.kind === 'assistant_delta') {
    const combined = generation.output + envelope.event.text
    const maxLength = 512 * 1024
    const overflow = Math.max(0, combined.length - maxLength)
    return {
      ...generation,
      output: overflow > 0 ? combined.slice(overflow) : combined,
      outputTruncated: generation.outputTruncated || overflow > 0,
      lastSeq: envelope.seq,
    }
  }

  const events = [
    ...generation.events,
    {
      runId: envelope.runId,
      seq: envelope.seq,
      at: envelope.at,
      event: envelope.event,
    },
  ].slice(-200)
  if (envelope.event.kind === 'evidence_ready') {
    return {
      ...generation,
      evidence: envelope.event.snapshot,
      events,
      lastSeq: envelope.seq,
    }
  }
  if (envelope.event.kind === 'phase') {
    return {
      ...generation,
      progress: envelope.event.progress,
      events,
      lastSeq: envelope.seq,
    }
  }
  if (envelope.event.kind === 'candidate_count') {
    return {
      ...generation,
      progress: {
        ...(generation.progress ?? { phase: 'generating' }),
        candidateCount: envelope.event.count,
      },
      events,
      lastSeq: envelope.seq,
    }
  }
  if (envelope.event.kind === 'project_response') {
    return {
      ...generation,
      projectResponses: [
        ...generation.projectResponses,
        envelope.event.response,
      ].slice(-100),
      events,
      lastSeq: envelope.seq,
    }
  }
  return { ...generation, events, lastSeq: envelope.seq }
}

function isActiveGeneration(generation: GenerationStatus | null): boolean {
  return generation?.state === 'running' || generation?.state === 'cancelling'
}

function generationStateColor(
  state: GenerationStatus['state'],
): 'default' | 'success' | 'warning' | 'danger' {
  if (state === 'completed') return 'success'
  if (state === 'failed') return 'danger'
  if (state === 'cancelled' || state === 'interrupted' || state === 'cancelling') {
    return 'warning'
  }
  return 'default'
}

function generationScopeLabel(generation: GenerationStatus): string {
  const request = generation.request
  if (!request) return tr('scope.unavailable')
  if (request.mode === 'full') return tr('scope.full')
  if (request.mode === 'changed7d') return tr('scope.changed')
  if (request.mode === 'projects') {
    return tr('scope.selected', { count: request.projects.length })
  }
  return tr('scope.recent')
}

function generationHistoryScopeLabel(entry: GenerationHistoryEntry): string {
  if (entry.request.mode === 'full') return tr('scope.full')
  if (entry.request.mode === 'changed7d') return tr('scope.changed')
  if (entry.request.mode === 'projects') {
    return tr('scope.selected', { count: entry.request.projects.length })
  }
  return tr('scope.recent')
}

function generationBatchLabel(entry: GenerationHistoryEntry): string {
  return [
    generationHistoryScopeLabel(entry),
    formatDateTime(entry.startedAt, currentLocale()),
    tr('history.candidateCount', { count: entry.candidateCount }),
  ].join(' · ')
}

function generationRunMeta(generation: GenerationStatus): string {
  const timestamp = generation.startedAt ?? generation.endedAt
  if (!timestamp) return generation.runId ?? tr('runTitle.background')
  return `${generation.runId ?? tr('runTitle.background')} · ${formatDateTime(timestamp, currentLocale())}`
}

function generationRunTitle(state: GenerationStatus['state']): string {
  if (state === 'completed') return tr('runTitle.completed')
  if (state === 'cancelled') return tr('runTitle.cancelled')
  if (state === 'failed') return tr('runTitle.failed')
  if (state === 'interrupted') return tr('runTitle.interrupted')
  if (state === 'cancelling') return tr('runTitle.cancelling')
  return tr('runTitle.running')
}

function generationPhases(generation: GenerationStatus): GenerationPhaseView[] {
  const completed = generation.state === 'completed'
  const stopped = ['cancelled', 'failed', 'interrupted'].includes(generation.state)
  const evidenceReady = Boolean(generation.evidence)
  const providerStarted = evidenceReady && (
    Boolean(generation.output)
    || generation.progress?.phase === 'generating'
    || generation.progress?.phase === 'splitting'
    || generation.progress?.phase === 'done'
  )
  const candidatesReady = completed || (generation.progress?.candidateCount ?? 0) > 0

  return [
    {
      key: 'evidence',
      label: tr('phases.prepare'),
      detail: evidenceReady
        ? tr('phases.evidenceReady', { count: generation.evidence?.totalSessions ?? 0 })
        : stopped ? tr('phases.evidenceStopped') : tr('phases.readingSessions'),
      status: evidenceReady ? 'done' : stopped ? 'pending' : 'active',
    },
    {
      key: 'generate',
      label: tr('phases.generate'),
      detail: generation.progress ? progressDetail(generation.progress) : tr('phases.waitingEvidence'),
      status: completed || candidatesReady
        ? 'done'
        : providerStarted && !stopped ? 'active' : 'pending',
    },
    {
      key: 'validate',
      label: tr('phases.validate'),
      detail: completed ? tr('phases.schemaValidated') : tr('phases.validateResponse'),
      status: completed ? 'done' : candidatesReady && !stopped ? 'active' : 'pending',
    },
    {
      key: 'save',
      label: tr('phases.save'),
      detail: completed
        ? tr('phases.saved', { count: generation.progress?.candidateCount ?? 0 })
        : tr('phases.saveAfterSuccess'),
      status: completed ? 'done' : 'pending',
    },
  ]
}

function AgentMark({ agent }: { agent: GlobalInstructionAgent }) {
  const config = {
    claude: { icon: Asterisk, className: 'bg-warning/15 text-warning' },
    codex: { icon: CircleDot, className: 'bg-primary-soft text-primary' },
    copilot: { icon: Bot, className: 'bg-accent/15 text-accent' },
    opencode: { icon: Terminal, className: 'bg-surface-hover text-foreground' },
    pi: { icon: Sigma, className: 'bg-secondary/15 text-secondary' },
  }[agent]
  const Icon = config.icon
  return (
    <span className={`grid size-10 place-items-center rounded-lg ${config.className}`}>
      <Icon aria-hidden="true" size={18} strokeWidth={2.2} />
    </span>
  )
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 px-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="truncate text-sm text-foreground">{value}</span>
    </div>
  )
}

function BackButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Button className="mb-5 gap-2 text-muted" onPress={onPress} variant="ghost">
      <ArrowLeft aria-hidden="true" size={17} />
      {label}
    </Button>
  )
}

function ConfidenceChip({ level }: { level: string }) {
  const color = level === 'high' ? 'success' : level === 'medium' ? 'warning' : 'default'
  return <Chip color={color} size="sm" variant="soft">{tr('confidence', { level })}</Chip>
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="break-words text-foreground">{value}</span>
    </div>
  )
}

function ErrorAlert({ title, message }: { title: string; message: string }) {
  return (
    <Alert status="danger">
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        <Alert.Description>{message}</Alert.Description>
      </Alert.Content>
    </Alert>
  )
}

function progressDetail(progress: GenerateProgress | null): string {
  if (!progress) return tr('progress.starting')
  if (progress.phase === 'done') return tr('progress.generated', { count: progress.candidateCount ?? 0 })
  if (progress.phase === 'extracting') return tr('progress.extracting')
  if (progress.phase === 'splitting') return tr('progress.splitting')
  if (progress.current !== undefined && progress.total !== undefined) {
    return tr('progress.bundles', {
      current: progress.current,
      total: progress.total,
      project: progress.projectSlug ? ` · ${progress.projectSlug}` : '',
    })
  }
  return progress.projectSlug ?? tr('progress.generating')
}

function instructionAgentLabel(agent: GlobalInstructionAgent): string {
  return {
    claude: 'Claude',
    codex: 'Codex',
    copilot: 'Copilot',
    opencode: 'OpenCode',
    pi: 'Pi',
  }[agent]
}

function autoMemorySourceTitle(source: AutoMemorySource): string {
  if (source.agent === 'codex') return tr('memory.codexTitle')
  const projectId = source.id.startsWith('project:')
    ? source.id.slice('project:'.length)
    : source.id
  return tr('memory.claudeProjectTitle', {
    agent: instructionAgentLabel(source.agent),
    project: projectId,
  })
}

function instructionAgentInitial(agent: GlobalInstructionAgent): string {
  return {
    claude: 'C',
    codex: 'CX',
    copilot: 'CP',
    opencode: 'O',
    pi: 'π',
  }[agent]
}

function formatBytes(bytes: number): string {
  return formatLocalizedBytes(bytes, currentLocale())
}

function formatInstructionSize(bytes: number): string {
  return formatBytes(bytes)
}

function formatInstructionModified(value: string | null): string {
  if (!value) return tr('status.notModified')
  return formatDateTime(value, currentLocale())
}

function isGenerateProgress(value: unknown): value is GenerateProgress {
  if (!value || typeof value !== 'object') return false
  return ['extracting', 'generating', 'splitting', 'done'].includes(
    String((value as Partial<GenerateProgress>).phase),
  )
}

function failureMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return tr('errors.generationFailed')
  const message = (value as { message?: unknown }).message
  return typeof message === 'string' && message ? message : tr('errors.generationFailed')
}
