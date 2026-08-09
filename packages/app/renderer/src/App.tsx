import { useState } from 'react'
import { Button, Tooltip } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import {
  Blocks,
  Bot,
  ChevronDown,
  FolderKanban,
  MessageSquareText,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ScanSearch,
  ScrollText,
  Settings,
  Sun,
} from 'lucide-react'
import { OverviewView } from './views/OverviewView'
import { ProjectsView } from './views/ProjectsView'
import { ChatView } from './views/ChatView'
import { RulesView } from './views/RulesView'
import type { RulesSection } from './views/RulesView'
import { SettingsView } from './views/SettingsView'
import { changeAppTheme, readStoredTheme } from './theme'
import type { ThemeMode } from './theme'

type ContentViewId = 'overview' | 'projects' | 'chat' | 'rules'
type ViewId = ContentViewId | 'settings'
type RulesNavigationGroupId = 'rules-management' | 'agent-context'

const workspaceNavigation = [
  { id: 'overview', labelKey: 'scan', icon: ScanSearch },
  { id: 'projects', labelKey: 'projects', icon: FolderKanban },
  { id: 'chat', labelKey: 'chat', icon: MessageSquareText },
] satisfies Array<{
  id: Exclude<ContentViewId, 'rules'>
  labelKey: string
  icon: typeof ScanSearch
}>

const rulesNavigationGroups: Array<{
  id: RulesNavigationGroupId
  labelKey: string
  icon: typeof ScrollText
  items: Array<{ id: RulesSection; labelKey: string }>
}> = [
  {
    id: 'rules-management',
    labelKey: 'rulesManagement',
    icon: ScrollText,
    items: [
      { id: 'overview', labelKey: 'rulesOverview' },
      { id: 'generated', labelKey: 'rulesWorkbench' },
    ],
  },
  {
    id: 'agent-context',
    labelKey: 'agentContext',
    icon: Bot,
    items: [
      { id: 'agents', labelKey: 'agentInstructions' },
      { id: 'memories', labelKey: 'agentMemory' },
    ],
  },
]

const rulesNavigationGroupBySection: Record<RulesSection, RulesNavigationGroupId> = {
  overview: 'rules-management',
  generated: 'rules-management',
  agents: 'agent-context',
  memories: 'agent-context',
}

export function App() {
  const { t } = useTranslation('navigation')
  const [activeView, setActiveView] = useState<ViewId>('overview')
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string | null>(null)
  const [selectedProjectTab, setSelectedProjectTab] = useState<'sessions' | 'rules'>('sessions')
  const [selectedRulesProject, setSelectedRulesProject] = useState<string | null>(null)
  const [selectedPublishProject, setSelectedPublishProject] = useState<string | null>(null)
  const [selectedRulesRunId, setSelectedRulesRunId] = useState<string | null>(null)
  const [selectedChatThreadId, setSelectedChatThreadId] = useState<string | null>(null)
  const [activeRulesSection, setActiveRulesSection] = useState<RulesSection>('overview')
  const [expandedRulesGroups, setExpandedRulesGroups] = useState<Record<RulesNavigationGroupId, boolean>>({
    'rules-management': true,
    'agent-context': true,
  })
  const [rulesViewKey, setRulesViewKey] = useState(0)
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme(window.localStorage))
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const selectRulesSection = (section: RulesSection) => {
    const groupId = rulesNavigationGroupBySection[section]
    setActiveRulesSection(section)
    setExpandedRulesGroups((current) => (
      current[groupId] ? current : { ...current, [groupId]: true }
    ))
  }

  const openRulesSection = (section: RulesSection) => {
    if (activeView === 'rules' && activeRulesSection === section && section === 'overview') {
      setRulesViewKey((current) => current + 1)
    }
    selectRulesSection(section)
    setActiveView('rules')
  }

  return (
    <>
      <div aria-hidden="true" className="window-drag-region">
        <div
          className="window-titlebar-toggle-region"
          onDoubleClick={() => { void window.api.invoke('window.toggleMaximize') }}
        />
      </div>
      <div
        className={`grid h-screen w-screen max-w-full overflow-hidden bg-background text-foreground transition-[grid-template-columns] duration-200 motion-reduce:transition-none ${
          sidebarCollapsed
            ? 'grid-cols-[3.5rem_minmax(0,1fr)]'
            : 'grid-cols-[11.125rem_minmax(0,1fr)] max-[980px]:grid-cols-[10.25rem_minmax(0,1fr)]'
        }`}
      >
        <aside
          className={`relative flex h-screen min-h-0 flex-col border-r border-border bg-sidebar pb-3 pt-11 ${
            sidebarCollapsed ? 'px-2' : 'px-3'
          }`}
        >
            <div className={`mb-5 flex h-7 items-center ${sidebarCollapsed ? 'justify-center' : 'gap-2.5 px-2'}`}>
              <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-foreground text-background">
                <Blocks aria-hidden="true" size={16} />
              </div>
              {!sidebarCollapsed && (
                <div className="grid min-w-0 gap-0.5">
                  <strong className="whitespace-nowrap text-xs font-medium tracking-[-0.02em] text-foreground">Agent Dashboard</strong>
                  <span className="truncate text-[10px] text-muted">{t('localIntelligence')}</span>
                </div>
              )}
            </div>

            <nav aria-label={t('mainLabel')} className="min-h-0 overflow-x-hidden overflow-y-auto">
              <div>
                {!sidebarCollapsed && (
                  <p className="mb-1 px-2 text-[9px] font-medium uppercase tracking-[0.1em] text-muted/70">
                    {t('workspace')}
                  </p>
                )}
                <div aria-label={t('workspace')} className="grid gap-0.5">
                  {workspaceNavigation.map(({ id, labelKey, icon: Icon }) => {
                    const active = activeView === id
                    return (
                      <Button
                        aria-label={sidebarCollapsed ? t(labelKey) : undefined}
                        aria-current={active ? 'page' : undefined}
                        className={`h-[2.125rem] text-[13px] ${
                          sidebarCollapsed ? 'justify-center px-0' : 'justify-start gap-2 px-2'
                        } ${
                          active
                            ? 'bg-surface-hover text-foreground'
                            : 'text-muted hover:bg-surface-hover hover:text-foreground'
                        }`}
                        fullWidth
                        key={id}
                        onPress={() => setActiveView(id)}
                        title={sidebarCollapsed ? t(labelKey) : undefined}
                        variant="ghost"
                      >
                        <Icon aria-hidden="true" size={16} />
                        {!sidebarCollapsed && <span>{t(labelKey)}</span>}
                      </Button>
                    )
                  })}
                </div>
              </div>

              <div className={sidebarCollapsed ? 'mt-3 border-t border-border pt-3' : 'mt-4'}>
                {!sidebarCollapsed && (
                  <p className="mb-1 px-2 text-[9px] font-medium uppercase tracking-[0.1em] text-muted/70">
                    {t('knowledge')}
                  </p>
                )}
                <div aria-label={t('rulesLabel')} className="grid gap-1">
                  {rulesNavigationGroups.map((group) => {
                    const expanded = expandedRulesGroups[group.id]
                    const groupActive = activeView === 'rules'
                      && group.items.some((item) => item.id === activeRulesSection)
                    const GroupIcon = group.icon

                    return (
                      <div className="grid gap-0.5" key={group.id} role="group">
                        <Button
                          aria-controls={`${group.id}-items`}
                          aria-expanded={!sidebarCollapsed && expanded}
                          aria-label={sidebarCollapsed ? t(group.labelKey) : undefined}
                          className={`h-[2.125rem] text-[13px] ${
                            sidebarCollapsed ? 'justify-center px-0' : 'justify-start gap-2 px-2'
                          } ${
                            groupActive
                              ? 'text-foreground'
                              : 'text-muted hover:bg-surface-hover hover:text-foreground'
                          }`}
                          fullWidth
                          onPress={() => {
                            if (sidebarCollapsed) {
                              setSidebarCollapsed(false)
                              setExpandedRulesGroups((current) => ({ ...current, [group.id]: true }))
                              return
                            }
                            setExpandedRulesGroups((current) => ({
                              ...current,
                              [group.id]: !current[group.id],
                            }))
                          }}
                          title={sidebarCollapsed ? t(group.labelKey) : undefined}
                          variant="ghost"
                        >
                          <GroupIcon aria-hidden="true" size={16} />
                          {!sidebarCollapsed && (
                            <>
                              <span>{t(group.labelKey)}</span>
                              <ChevronDown
                                aria-hidden="true"
                                className={`ml-auto transition-transform motion-reduce:transition-none ${
                                  expanded ? 'rotate-0' : '-rotate-90'
                                }`}
                                size={14}
                              />
                            </>
                          )}
                        </Button>
                        {!sidebarCollapsed && expanded && (
                          <div
                            className="ml-[15px] grid gap-0.5 border-l border-border/80 py-0.5 pl-2"
                            id={`${group.id}-items`}
                          >
                            {group.items.map((item) => {
                              const active = activeView === 'rules' && activeRulesSection === item.id
                              return (
                                <Button
                                  aria-current={active ? 'page' : undefined}
                                  className={`h-[1.875rem] justify-start rounded-md px-2 text-[12px] ${
                                    active
                                      ? 'bg-surface-hover text-foreground'
                                      : 'text-muted hover:bg-surface-hover hover:text-foreground'
                                  }`}
                                  fullWidth
                                  key={item.id}
                                  onPress={() => openRulesSection(item.id)}
                                  variant="ghost"
                                >
                                  {t(item.labelKey)}
                                </Button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </nav>

            <div className={`mt-auto gap-1 border-t border-border pt-3 ${
              sidebarCollapsed ? 'grid justify-items-center' : 'flex items-center'
            }`}>
              <Button
                aria-label={sidebarCollapsed ? t('settings') : undefined}
                aria-current={activeView === 'settings' ? 'page' : undefined}
                className={`h-[2.125rem] min-w-0 text-[13px] ${
                  sidebarCollapsed
                    ? 'w-[2.125rem] justify-center px-0'
                    : 'flex-1 justify-start gap-2 px-2'
                } ${
                  activeView === 'settings'
                    ? 'bg-surface-hover text-foreground'
                    : 'text-muted hover:bg-surface-hover hover:text-foreground'
                }`}
                fullWidth
                onPress={() => setActiveView('settings')}
                title={sidebarCollapsed ? t('settings') : undefined}
                variant="ghost"
              >
                <Settings aria-hidden="true" size={16} />
                {!sidebarCollapsed && <span>{t('settings')}</span>}
              </Button>
              <Tooltip>
                <Button
                  aria-label={theme === 'dark' ? t('switchLight') : t('switchDark')}
                  className="size-[2.125rem] min-w-[2.125rem] shrink-0 text-muted hover:bg-surface-hover hover:text-foreground"
                  isIconOnly
                  onPress={() => {
                    const nextTheme = theme === 'dark' ? 'light' : 'dark'
                    changeAppTheme(nextTheme)
                    setTheme(nextTheme)
                  }}
                  variant="ghost"
                >
                  {theme === 'dark' ? (
                    <Sun aria-hidden="true" size={16} />
                  ) : (
                    <Moon aria-hidden="true" size={16} />
                  )}
                </Button>
                <Tooltip.Content>
                  {theme === 'dark' ? t('switchLight') : t('switchDark')}
                </Tooltip.Content>
              </Tooltip>
            </div>
          </aside>

          <main
            className={`relative min-w-0 max-w-full overflow-x-hidden bg-background ${
              activeView === 'chat' || activeView === 'settings'
                ? 'overflow-y-hidden'
                : 'overflow-y-auto px-[clamp(1.75rem,5vw,4.5rem)] py-12'
            }`}
            key={activeView}
          >
            <div className="sidebar-collapse-toggle">
              <Tooltip>
                <Button
                  aria-label={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
                  className="size-8 min-w-8 rounded-md border border-border bg-background p-0 text-muted shadow-sm hover:bg-surface-hover hover:text-foreground"
                  isIconOnly
                  onPress={() => setSidebarCollapsed((current) => !current)}
                  variant="ghost"
                >
                  {sidebarCollapsed ? (
                    <PanelLeftOpen aria-hidden="true" size={15} />
                  ) : (
                    <PanelLeftClose aria-hidden="true" size={15} />
                  )}
                </Button>
                <Tooltip.Content>
                  {sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
                </Tooltip.Content>
              </Tooltip>
            </div>

            {activeView === 'settings' && (
              <SettingsView
                onThemeChange={(nextTheme) => {
                  changeAppTheme(nextTheme)
                  setTheme(nextTheme)
                }}
                theme={theme}
              />
            )}
            {activeView === 'overview' && (
              <OverviewView
                onOpenProject={(slug) => {
                  setSelectedProjectSlug(slug)
                  setSelectedProjectTab('sessions')
                  setActiveView('projects')
                }}
              />
            )}
            {activeView === 'projects' && (
              <ProjectsView
                initialProjectSlug={selectedProjectSlug}
                initialProjectTab={selectedProjectTab}
                onInitialProjectHandled={() => {
                  setSelectedProjectSlug(null)
                  setSelectedProjectTab('sessions')
                }}
                onGenerateRules={(slug) => {
                  setSelectedRulesProject(slug)
                  openRulesSection('overview')
                }}
                onPublishRules={(slug) => {
                  setSelectedPublishProject(slug)
                  openRulesSection('generated')
                }}
              />
            )}
            {activeView === 'chat' && (
              <ChatView
                initialThreadId={selectedChatThreadId}
                onOpenGeneratedRules={(runId) => {
                  selectRulesSection('generated')
                  setSelectedRulesRunId(runId)
                  setSelectedChatThreadId(null)
                  setActiveView('rules')
                }}
              />
            )}
            {activeView === 'rules' && (
              <RulesView
                initialProjectSlug={selectedRulesProject}
                initialPublishProjectSlug={selectedPublishProject}
                initialRunId={selectedRulesRunId}
                key={rulesViewKey}
                onInitialProjectHandled={() => setSelectedRulesProject(null)}
                onInitialPublishProjectHandled={() => setSelectedPublishProject(null)}
                onInitialRunHandled={() => setSelectedRulesRunId(null)}
                onOpenProjectRules={(slug) => {
                  setSelectedProjectSlug(slug ?? null)
                  setSelectedProjectTab('rules')
                  setActiveView('projects')
                }}
                onOpenChat={(threadId) => {
                  setSelectedChatThreadId(threadId)
                  setActiveView('chat')
                }}
                onSectionChange={selectRulesSection}
                section={activeRulesSection}
              />
            )}
          </main>
        </div>
    </>
  )
}
