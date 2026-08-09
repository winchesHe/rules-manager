import { useDeferredValue, useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { Button, Card, Chip, Input, Spinner, Table, TextField } from '@heroui/react'
import { ChevronRight, FileSearch, FolderOpen, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { afterNextPaint } from '../async'
import { PageHeader } from '../components/PageHeader'
import { FilterTransition, PageTransition } from '../components/UxTransition'
import { EmptyProjects, ViewError } from '../components/ViewStates'
import { currentLocale, i18n } from '../i18n'
import { formatBytes, formatDateTime } from '../i18n/format'
import type {
  Project,
  ProjectMemoryPublicationStatusResult,
  ProjectRulesOutputReadResult,
  ProjectSession,
  RuleCandidate,
  RuleStatus,
  ScanStatus,
  SessionPreview,
} from '../types'
import {
  calculateVirtualWindow,
  filterProjectRows,
  filterProjectSessions,
  groupScanChanges,
  type ProjectFilter,
} from '../view-models'

type ProjectsPage = 'list' | 'detail'
type DetailTab = 'sessions' | 'rules'
type ProjectRulesView = 'candidates' | 'published'

interface ProjectRow extends Project {
  changedCount: number
  draftCount: number
  isUnclassified: boolean
}

const projectFilters: Array<{ value: ProjectFilter; labelKey: string }> = [
  { value: 'all', labelKey: 'filters.all' },
  { value: 'changed', labelKey: 'filters.changed' },
  { value: 'draft', labelKey: 'filters.draft' },
  { value: 'unclassified', labelKey: 'filters.unclassified' },
]

export function ProjectsView({
  initialProjectSlug,
  initialProjectTab,
  onInitialProjectHandled,
  onGenerateRules,
  onPublishRules,
}: {
  initialProjectSlug?: string | null
  initialProjectTab?: DetailTab
  onInitialProjectHandled?: () => void
  onGenerateRules?: (slug: string) => void
  onPublishRules?: (slug: string) => void
}) {
  const { t } = useTranslation('projects')
  const [page, setPage] = useState<ProjectsPage>('list')
  const [projects, setProjects] = useState<Project[]>([])
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null)
  const [drafts, setDrafts] = useState<RuleCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ProjectFilter>('all')
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const deferredQuery = useDeferredValue(query)

  useEffect(() => {
    let current = true
    setLoading(true)
    setError(null)
    void afterNextPaint(() =>
      Promise.all([
        window.api.invoke<Project[]>('projects.list'),
        window.api.invoke<ScanStatus>('scan.status'),
        window.api.invoke<RuleCandidate[]>('rules.candidates', 'draft'),
      ]),
    )
      .then(([projectRows, status, draftRows]) => {
        if (!current) return
        setProjects(projectRows)
        setScanStatus(status)
        setDrafts(draftRows)
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
    if (!initialProjectSlug || projects.length === 0) return
    const project = projects.find((row) => row.slug === initialProjectSlug)
    if (project) {
      setSelectedProject(project)
      setPage('detail')
    }
    onInitialProjectHandled?.()
  }, [initialProjectSlug, onInitialProjectHandled, projects])

  const rows = useMemo<ProjectRow[]>(() => {
    const changeCounts = new Map(
      scanStatus?.summary
        ? groupScanChanges(scanStatus.summary).map((row) => [
            row.slug,
            row.newCount + row.updatedCount + row.missingCount,
          ])
        : [],
    )
    const draftCounts = new Map<string, number>()
    for (const candidate of drafts) {
      if (!candidate.project_slug) continue
      draftCounts.set(candidate.project_slug, (draftCounts.get(candidate.project_slug) ?? 0) + 1)
    }
    return projects.map((project) => ({
      ...project,
      changedCount: changeCounts.get(project.slug) ?? 0,
      draftCount: draftCounts.get(project.slug) ?? 0,
      isUnclassified: project.slug === 'default',
    }))
  }, [drafts, projects, scanStatus])

  const filteredRows = useMemo(
    () => filterProjectRows(rows, deferredQuery, filter),
    [deferredQuery, filter, rows],
  )
  const isFiltering = deferredQuery !== query

  function openProject(project: Project): void {
    setSelectedProject(project)
    setPage('detail')
  }

  if (error) return <ViewError message={error} title={t('errors.loadProjects')} />
  if (page === 'detail' && selectedProject) {
    return (
      <PageTransition transitionKey={`project:${selectedProject.slug}`}>
        <ProjectDetails
          initialTab={initialProjectTab}
          onGenerateRules={() => onGenerateRules?.(selectedProject.slug)}
          onPublishRules={() => onPublishRules?.(selectedProject.slug)}
          onBack={() => setPage('list')}
          project={selectedProject}
        />
      </PageTransition>
    )
  }

  return (
    <PageTransition transitionKey="projects:list">
      <PageHeader
        description={t('description')}
        title={t('title')}
      />
      <div className="mb-5 grid gap-3">
        <TextField className="max-w-xl" onChange={setQuery} value={query}>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-muted"
              size={17}
            />
            <Input className="pl-10" fullWidth placeholder={t('list.search')} />
          </div>
        </TextField>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div aria-label={t('filters.label')} className="flex flex-wrap gap-2">
            {projectFilters.map((item) => (
              <Button
                aria-pressed={filter === item.value}
                key={item.value}
                onPress={() => setFilter(item.value)}
                size="sm"
                variant={filter === item.value ? 'primary' : 'ghost'}
              >
                {t(item.labelKey)}
              </Button>
            ))}
          </div>
          {!loading && (
            <span aria-live="polite" className="text-xs tabular-nums text-muted">
              {t('list.filteredCount', { visible: filteredRows.length, total: rows.length })}
            </span>
          )}
        </div>
      </div>

      <FilterTransition
        busy={isFiltering}
        transitionKey={`projects:${filter}:${deferredQuery}`}
      >
        <Card className="min-h-80 border border-border bg-surface shadow-none">
          <Card.Content className="p-0">
          {loading ? (
            <div className="min-h-64" />
          ) : projects.length === 0 ? (
            <EmptyProjects />
          ) : filteredRows.length === 0 ? (
            <div className="grid min-h-64 place-items-center text-sm text-muted">
              {t('list.emptyFilter')}
            </div>
          ) : (
            <Table className="rounded-none bg-transparent shadow-none">
              <Table.ScrollContainer>
                    <Table.Content
                      aria-label={t('list.tableLabel')}
                      onRowAction={(key) => {
                        const project = filteredRows.find((item) => item.slug === String(key))
                        if (project) openProject(project)
                      }}
                    >
                  <Table.Header>
                    <Table.Column isRowHeader>{t('columns.project')}</Table.Column>
                    <Table.Column>{t('columns.agents')}</Table.Column>
                    <Table.Column>{t('columns.sessions')}</Table.Column>
                    <Table.Column>{t('columns.latestChange')}</Table.Column>
                    <Table.Column>{t('columns.draftRules')}</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {filteredRows.map((project) => (
                      <Table.Row
                        aria-label={t('list.openProject', { project: project.slug })}
                            className="cursor-pointer rounded-none outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [&>td]:rounded-none"
                        id={project.slug}
                        key={project.slug}
                      >
                        <Table.Cell>
                          <span className="font-medium text-foreground">{project.slug}</span>
                        </Table.Cell>
                        <Table.Cell className="text-muted">
                          {project.agents.join(' · ') || '—'}
                        </Table.Cell>
                        <Table.Cell>{project.sessionCount}</Table.Cell>
                        <Table.Cell>
                          {project.changedCount > 0 ? (
                            <Chip color="warning" size="sm" variant="soft">
                              {t('list.changed', { count: project.changedCount })}
                            </Chip>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          {project.draftCount > 0 ? (
                            <Chip size="sm" variant="soft">{project.draftCount}</Chip>
                          ) : (
                            <span className="text-muted">—</span>
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
      </FilterTransition>
    </PageTransition>
  )
}

function ProjectDetails({
  project,
  initialTab = 'sessions',
  onBack,
  onGenerateRules,
  onPublishRules,
}: {
  project: Project
  initialTab?: DetailTab
  onBack: () => void
  onGenerateRules: () => void
  onPublishRules: () => void
}) {
  const { t } = useTranslation('projects')
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const [rulesView, setRulesView] = useState<ProjectRulesView>('candidates')
  const [sessions, setSessions] = useState<ProjectSession[]>([])
  const [rules, setRules] = useState<RuleCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sessionQuery, setSessionQuery] = useState('')
  const deferredSessionQuery = useDeferredValue(sessionQuery)
  const [sessionAgent, setSessionAgent] = useState('all')
  const [sessionStatus, setSessionStatus] = useState('all')
  const [sessionScrollTop, setSessionScrollTop] = useState(0)
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null)
  const [revealError, setRevealError] = useState<string | null>(null)

  async function revealProject(): Promise<void> {
    setRevealError(null)
    try {
      await window.api.invoke('projects.reveal', project.slug)
    } catch {
      setRevealError(t('errors.revealProject'))
    }
  }

  useEffect(() => {
    let current = true
    setLoading(true)
    setError(null)
    void afterNextPaint(() =>
      Promise.all([
        window.api.invoke<ProjectSession[]>('projects.sessions', project.slug),
        ...(['draft', 'accepted', 'rejected'] as RuleStatus[]).map((status) =>
          window.api.invoke<RuleCandidate[]>('rules.candidates', status),
        ),
      ]),
    )
      .then(([sessionRows, ...candidateGroups]) => {
        if (!current) return
        setSessions(sessionRows)
        setRules(candidateGroups.flat().filter((row) => row.project_slug === project.slug))
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
  }, [project.slug])

  const sessionAgents = useMemo(
    () => [...new Set(sessions.map((session) => session.agent))].sort(),
    [sessions],
  )
  const sessionStatuses = useMemo(
    () => [...new Set(sessions.map((session) => session.status))].sort(),
    [sessions],
  )
  const filteredSessions = useMemo(
    () => filterProjectSessions(
      sessions,
      deferredSessionQuery,
      sessionAgent,
      sessionStatus,
    ),
    [deferredSessionQuery, sessionAgent, sessions, sessionStatus],
  )
  const isSessionFiltering = deferredSessionQuery !== sessionQuery

  if (selectedSession) {
    return (
      <SessionDetails
        onBackToProject={() => setSelectedSession(null)}
        onBackToProjects={onBack}
        projectSlug={project.slug}
        session={selectedSession}
      />
    )
  }

  return (
    <>
      <ProjectBreadcrumbs onBackToProjects={onBack} projectSlug={project.slug} />
      <PageHeader
        actions={(
          <Button onPress={() => void revealProject()} variant="ghost">
            <FolderOpen aria-hidden="true" size={16} />
            {t('details.openProjectLocation')}
          </Button>
        )}
        description={t('details.description', {
          count: project.sessionCount,
          agents: project.agents.join(' · ') || t('details.noAgents'),
        })}
        title={project.slug}
      />
      {revealError && (
        <p className="mb-4 text-sm text-danger" role="alert">{revealError}</p>
      )}
      <div aria-label={t('details.label')} className="mb-4 flex gap-2">
        {(['sessions', 'rules'] as DetailTab[]).map((item) => (
          <Button
            aria-pressed={tab === item}
            key={item}
            onPress={() => setTab(item)}
            variant={tab === item ? 'primary' : 'ghost'}
          >
            <span>
              {item === 'sessions' ? t('details.sessionsTab') : t('details.rulesTab')}
            </span>
            <Chip size="sm" variant="soft">
              {item === 'sessions' ? sessions.length : rules.length}
            </Chip>
          </Button>
        ))}
      </div>
      {tab === 'rules' && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div aria-label={t('rules.viewsLabel')} className="flex gap-2">
            {(['candidates', 'published'] as ProjectRulesView[]).map((view) => (
              <Button
                aria-pressed={rulesView === view}
                key={view}
                onPress={() => setRulesView(view)}
                variant={rulesView === view ? 'primary' : 'ghost'}
              >
                {view === 'candidates' ? t('rules.candidates') : t('rules.published')}
              </Button>
            ))}
          </div>
          <Button onPress={onGenerateRules} variant="ghost">
            {t('details.generate')}
          </Button>
        </div>
      )}
      {tab === 'sessions' && (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <TextField
            className="min-w-64 flex-1"
            onChange={(value) => {
              setSessionQuery(value)
              setSessionScrollTop(0)
            }}
            value={sessionQuery}
          >
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-muted"
                size={17}
              />
              <Input className="pl-10" fullWidth placeholder={t('details.searchSessions')} />
            </div>
          </TextField>
          <label className="grid gap-1 text-xs text-muted">
            {t('details.agent')}
            <select
              className="h-10 min-w-32 rounded-lg border border-border bg-surface px-3 text-sm text-foreground outline-none focus:border-primary"
              onChange={(event) => {
                setSessionAgent(event.currentTarget.value)
                setSessionScrollTop(0)
              }}
              value={sessionAgent}
            >
              <option value="all">{t('details.allAgents')}</option>
              {sessionAgents.map((agent) => (
                <option key={agent} value={agent}>{agent}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted">
            {t('details.status')}
            <select
              className="h-10 min-w-36 rounded-lg border border-border bg-surface px-3 text-sm text-foreground outline-none focus:border-primary"
              onChange={(event) => {
                setSessionStatus(event.currentTarget.value)
                setSessionScrollTop(0)
              }}
              value={sessionStatus}
            >
              <option value="all">{t('details.allStatuses')}</option>
              {sessionStatuses.map((status) => (
                <option key={status} value={status}>
                  {t(`common:status.${status}`, { defaultValue: status })}
                </option>
              ))}
            </select>
          </label>
          <span className="pb-2 text-sm text-muted">
            {t('details.filteredCount', {
              visible: filteredSessions.length,
              total: sessions.length,
            })}
          </span>
        </div>
      )}
      <FilterTransition
        busy={isSessionFiltering}
        transitionKey={`${tab}:${rulesView}:${sessionAgent}:${sessionStatus}:${deferredSessionQuery}`}
      >
        <Card className="min-h-80 border border-border bg-surface shadow-none">
          <Card.Content className="p-0">
          {loading ? (
            <ViewLoading label={t('loading.project', { project: project.slug })} />
          ) : error ? (
            <div className="p-6">
              <ViewError message={error} title={t('errors.loadDetails')} />
            </div>
          ) : tab === 'sessions' ? (
            <VirtualSessionList
              onOpen={setSelectedSession}
              onScrollTopChange={setSessionScrollTop}
              scrollTop={sessionScrollTop}
              sessions={filteredSessions}
            />
          ) : rulesView === 'candidates' ? (
            <ProjectRules rules={rules} />
          ) : (
            <PublishedProjectRules
              onPublishRules={onPublishRules}
              projectSlug={project.slug}
            />
          )}
          </Card.Content>
        </Card>
      </FilterTransition>
    </>
  )
}

function VirtualSessionList({
  sessions,
  onOpen,
  scrollTop,
  onScrollTopChange,
}: {
  sessions: ProjectSession[]
  onOpen: (session: ProjectSession) => void
  scrollTop: number
  onScrollTopChange: (scrollTop: number) => void
}) {
  const { t } = useTranslation('projects')
  const rowHeight = 56
  const viewportHeight = 392
  const viewportRef = useRef<HTMLDivElement>(null)
  const window = calculateVirtualWindow({
    itemCount: sessions.length,
    scrollTop,
    rowHeight,
    viewportHeight,
    overscan: 4,
  })
  const visible = sessions.slice(window.start, window.end)

  useEffect(() => {
    if (viewportRef.current && viewportRef.current.scrollTop !== scrollTop) {
      viewportRef.current.scrollTop = scrollTop
    }
  }, [scrollTop])

  if (sessions.length === 0) {
    return (
      <div className="grid min-h-64 place-items-center text-sm text-muted">
        {t('sessions.emptyFilter')}
      </div>
    )
  }

  return (
    <div
      aria-label={t('sessions.listLabel')}
      className="overflow-y-auto"
      onScroll={(event: UIEvent<HTMLDivElement>) =>
        onScrollTopChange(event.currentTarget.scrollTop)}
      ref={viewportRef}
      style={{ height: viewportHeight }}
    >
      <div className="relative" style={{ height: window.totalHeight }}>
        <div
          className="absolute inset-x-0 top-0"
          style={{ transform: `translateY(${window.offsetTop}px)` }}
          >
            {visible.map((session) => (
              <button
                className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_8rem_8rem] items-center gap-4 border-b border-border px-5 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                key={session.id}
                onClick={() => onOpen(session)}
                style={{ height: rowHeight }}
                type="button"
              >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground" title={session.displayName}>
                  {session.displayName}
                </p>
                <p className="truncate text-xs text-muted" title={session.id}>
                  {session.agent} · {session.id}
                </p>
              </div>
              <span className="capitalize text-sm text-muted">{session.agent}</span>
              <Chip
                color={session.status === 'error' ? 'danger' : session.status === 'updated' ? 'warning' : 'default'}
                size="sm"
                variant="soft"
              >
                  {t(`common:status.${session.status}`, { defaultValue: session.status })}
                </Chip>
              </button>
            ))}
        </div>
      </div>
    </div>
  )
}

function SessionDetails({
  session,
  projectSlug,
  onBackToProject,
  onBackToProjects,
}: {
  session: ProjectSession
  projectSlug: string
  onBackToProject: () => void
  onBackToProjects: () => void
}) {
  const { t } = useTranslation('projects')
  const [preview, setPreview] = useState<SessionPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revealError, setRevealError] = useState<string | null>(null)

  async function revealSession(): Promise<void> {
    setRevealError(null)
    try {
      await window.api.invoke('sessions.reveal', session.id)
    } catch {
      setRevealError(t('errors.revealSession'))
    }
  }

  useEffect(() => {
    let current = true
    setLoading(true)
    setError(null)
    void afterNextPaint(() =>
      window.api.invoke<SessionPreview>('sessions.preview', session.id),
    )
      .then((value) => {
        if (current) setPreview(value)
      })
      .catch((reason: unknown) => {
        if (!current) return
        setError(
          isMissingIpcHandler(reason)
            ? i18n.t('projects:errors.previewVersion')
            : reason instanceof Error ? reason.message : String(reason),
        )
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [session.id])

  const totalMessages = preview?.messages.length ?? 0
  const visibleMessages = preview?.messages.slice(-200) ?? []

  return (
    <>
      <ProjectBreadcrumbs
        onBackToProject={onBackToProject}
        onBackToProjects={onBackToProjects}
        projectSlug={projectSlug}
        sessionId={session.displayName}
      />
      <PageHeader
        actions={(
          <Button onPress={() => void revealSession()} variant="ghost">
            <FileSearch aria-hidden="true" size={16} />
            {t('sessions.openLocation')}
          </Button>
        )}
        description={`${session.agent} · ${session.status}`}
        title={session.displayName}
      />
      {revealError && (
        <p className="mb-4 text-sm text-danger" role="alert">{revealError}</p>
      )}
      <Card className="mb-4 border border-border bg-surface shadow-none">
        <Card.Content className="grid gap-2 p-4">
          <p className="break-all text-sm text-muted">{session.sourcePath}</p>
          <p className="break-all font-mono text-xs text-muted">{session.id}</p>
          <div className="flex flex-wrap gap-2">
            <Chip size="sm" variant="soft">{session.agent}</Chip>
            <Chip size="sm" variant="soft">
              {t(`common:status.${session.status}`, { defaultValue: session.status })}
            </Chip>
            <Chip size="sm" variant="soft">
              {visibleMessages.length === totalMessages
                ? t('sessions.messages', { count: totalMessages })
                : t('sessions.latestMessages', {
                    visible: visibleMessages.length,
                    total: totalMessages,
                  })}
            </Chip>
          </div>
        </Card.Content>
      </Card>
      <Card className="min-h-80 border border-border bg-surface shadow-none">
        <Card.Content className="p-0">
          {loading ? (
            <ViewLoading label={t('loading.session')} />
          ) : error ? (
            <div className="p-6">
              <ViewError message={error} title={t('errors.openSession')} />
            </div>
          ) : visibleMessages.length === 0 ? (
            <div className="grid min-h-64 place-items-center text-sm text-muted">
              {t('sessions.emptyPreview')}
            </div>
          ) : (
            <div aria-label={t('sessions.messagesLabel')}>
              {visibleMessages.map((message, index) => (
                <article
                  className="grid gap-3 border-b border-border p-5 last:border-b-0"
                  key={`${message.timestamp ?? 'message'}-${index}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip size="sm" variant="soft">{message.role}</Chip>
                    {message.timestamp && (
                      <time className="text-xs text-muted">{message.timestamp}</time>
                    )}
                  </div>
                  {message.text && (
                    <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                      {message.text}
                    </p>
                  )}
                  {message.tools.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {message.tools.map((tool, toolIndex) => (
                        <Chip key={`${tool.tool}-${toolIndex}`} size="sm" variant="soft">
                          {tool.summary}: {tool.tool}
                        </Chip>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </Card.Content>
      </Card>
    </>
  )
}

function ProjectBreadcrumbs({
  projectSlug,
  sessionId,
  onBackToProjects,
  onBackToProject,
}: {
  projectSlug: string
  sessionId?: string
  onBackToProjects: () => void
  onBackToProject?: () => void
}) {
  const { t } = useTranslation('projects')
  return (
    <nav aria-label={t('breadcrumbs.label')} className="mb-5">
      <ol className="flex min-w-0 items-center gap-2 text-sm text-muted">
        <li>
          <button
            className="rounded px-1 py-1 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
            onClick={onBackToProjects}
            type="button"
          >
            {t('breadcrumbs.projects')}
          </button>
        </li>
        <li aria-hidden="true">
          <ChevronRight size={15} />
        </li>
        <li className="min-w-0">
          {sessionId ? (
            <button
              className="max-w-72 truncate rounded px-1 py-1 text-left outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
              onClick={onBackToProject}
              title={projectSlug}
              type="button"
            >
              {projectSlug}
            </button>
          ) : (
            <span aria-current="page" className="block max-w-72 truncate px-1 text-foreground">
              {projectSlug}
            </span>
          )}
        </li>
        {sessionId && (
          <>
            <li aria-hidden="true">
              <ChevronRight size={15} />
            </li>
            <li aria-current="page" className="min-w-0 truncate text-foreground" title={sessionId}>
              {t('sessions.session')}
            </li>
          </>
        )}
      </ol>
    </nav>
  )
}

function isMissingIpcHandler(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.includes("No handler registered for 'sessions.preview'")
}

function PublishedProjectRules({
  projectSlug,
  onPublishRules,
}: {
  projectSlug: string
  onPublishRules: () => void
}) {
  const { t } = useTranslation('projects')
  const [result, setResult] = useState<ProjectRulesOutputReadResult | null>(null)
  const [memoryStatus, setMemoryStatus] =
    useState<ProjectMemoryPublicationStatusResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let current = true
    setLoading(true)
    setError(null)
    setResult(null)
    void afterNextPaint(() =>
      Promise.all([
        window.api.invoke<ProjectRulesOutputReadResult>(
          'rules.projectOutput.read',
          projectSlug,
        ),
        window.api.invoke<ProjectMemoryPublicationStatusResult>(
          'rules.projectMemory.status',
          projectSlug,
        ),
      ]),
    )
      .then(([output, publication]) => {
        if (!current) return
        setResult(output)
        setMemoryStatus(publication)
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
  }, [projectSlug, refresh])

  if (loading) {
    return (
      <div className="grid min-h-64 place-items-center">
        <Spinner aria-label={t('rules.loadingPublished')} color="accent" size="lg" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-6">
        <ViewError message={error} title={t('errors.loadPublishedRules')} />
      </div>
    )
  }
  if (!result || !memoryStatus) return null
  if (result.source.status === 'missing') {
    return (
      <div className="grid min-h-64 place-items-center px-6 py-10 text-center">
        <div className="max-w-2xl">
          <strong className="text-sm font-medium text-foreground">{t('rules.notPublished')}</strong>
          <p className="mt-2 text-sm text-muted">{t('rules.notPublishedDescription')}</p>
          <code className="mt-3 block break-all text-xs text-muted">{result.source.path}</code>
          <Button className="mt-4" onPress={() => setRefresh((value) => value + 1)} variant="ghost">
            {t('rules.reloadPublished')}
          </Button>
          <Button className="ml-2 mt-4" onPress={onPublishRules} variant="primary">
            {t('rules.publishToMemory')}
          </Button>
          <MemoryPublicationStatus status={memoryStatus} />
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <code className="min-w-0 flex-1 truncate text-xs text-foreground">{result.source.path}</code>
        <Chip color="success" size="sm" variant="soft">{t('rules.exportedFile')}</Chip>
      </div>
      <pre
        aria-label={t('rules.publishedContent', { project: projectSlug })}
        className="min-h-64 whitespace-pre-wrap break-words bg-background/60 p-5 font-mono text-sm leading-7 text-foreground"
      >
        {result.content}
      </pre>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3.5">
        <span className="text-xs text-muted">
          {t('rules.publishedMetadata', {
            size: formatBytes(result.source.sizeBytes, currentLocale()),
            time: result.source.modifiedAt
              ? formatDateTime(result.source.modifiedAt, currentLocale())
              : '—',
          })}
        </span>
        <Button onPress={() => setRefresh((value) => value + 1)} variant="ghost">
          {t('rules.reloadPublished')}
        </Button>
      </div>
      <p className="border-t border-border px-5 py-4 text-xs text-muted">
        {t('rules.exportedFileDescription')}
      </p>
      <div className="border-t border-border px-5 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <strong className="text-sm font-medium text-foreground">
            {t('rules.memoryPublicationTitle')}
          </strong>
          <Button onPress={onPublishRules} variant="primary">
            {t('rules.publishToMemory')}
          </Button>
        </div>
        <MemoryPublicationStatus status={memoryStatus} />
      </div>
    </div>
  )
}

function MemoryPublicationStatus({
  status,
}: {
  status: ProjectMemoryPublicationStatusResult
}) {
  const { t } = useTranslation('projects')
  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      {[status.claude, status.codex].map((agentStatus) => {
        const relevantTargets = agentStatus.targets.filter((target) =>
          target.status === 'synced' || target.status === 'outdated')
        const targetLabels = relevantTargets.map((target) => target.label).join(' · ')
        return (
          <div className="min-w-0 rounded-xl border border-border bg-background/60 p-4" key={agentStatus.agent}>
            <div className="flex items-center justify-between gap-3">
              <strong className="text-sm font-medium text-foreground">
                {t(`rules.memoryAgents.${agentStatus.agent}`)}
              </strong>
              <Chip
                color={memoryStatusColor(agentStatus.status)}
                size="sm"
                variant="soft"
              >
                {t(`rules.memoryStatus.${agentStatus.status}`)}
              </Chip>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted">
              {t('rules.memoryRuleCount', { count: agentStatus.acceptedRuleCount })}
            </p>
            {relevantTargets.length > 0 && (
              <p className="mt-1 truncate text-xs text-muted" title={targetLabels}>
                {targetLabels}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function memoryStatusColor(
  status: ProjectMemoryPublicationStatusResult['claude']['status'],
): 'success' | 'warning' | 'default' {
  if (status === 'synced') return 'success'
  if (status === 'outdated') return 'warning'
  return 'default'
}

function ProjectRules({ rules }: { rules: RuleCandidate[] }) {
  const { t } = useTranslation('projects')
  if (rules.length === 0) {
    return <div className="grid min-h-64 place-items-center text-sm text-muted">{t('rules.empty')}</div>
  }
  return (
    <div>
      {rules.map((rule) => (
        <div className="grid gap-2 border-b border-border p-5 last:border-b-0" key={rule.id}>
          <p className="text-sm text-foreground">{rule.rule_text}</p>
          <div className="flex gap-2">
            <Chip size="sm" variant="soft">
              {t(`common:status.${rule.status}`, { defaultValue: rule.status })}
            </Chip>
            <Chip size="sm" variant="soft">
              {t('rules.confidence', { level: rule.confidence_level })}
            </Chip>
          </div>
        </div>
      ))}
    </div>
  )
}
