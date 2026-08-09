import { useState } from 'react'
import { Button, Tooltip } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import {
  Blocks,
  FolderKanban,
  MessageSquareText,
  Moon,
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

const navigationGroups = [
  {
    labelKey: 'workspace',
    items: [
      { id: 'overview', labelKey: 'scan', icon: ScanSearch },
      { id: 'projects', labelKey: 'projects', icon: FolderKanban },
      { id: 'chat', labelKey: 'chat', icon: MessageSquareText },
    ],
  },
  {
    labelKey: 'knowledge',
    items: [
      { id: 'rules', labelKey: 'rules', icon: ScrollText },
    ],
  },
] satisfies Array<{
  labelKey: string
  items: Array<{ id: ContentViewId; labelKey: string; icon: typeof ScanSearch }>
}>

const rulesNavigationGroups: Array<{
  labelKey: string
  items: Array<{ id: RulesSection; labelKey: string }>
}> = [
  {
    labelKey: 'rulesManagement',
    items: [
      { id: 'overview', labelKey: 'rulesOverview' },
      { id: 'generated', labelKey: 'rulesWorkbench' },
    ],
  },
  {
    labelKey: 'agentContext',
    items: [
      { id: 'agents', labelKey: 'agentInstructions' },
      { id: 'memories', labelKey: 'agentMemory' },
    ],
  },
]

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
  const [rulesViewKey, setRulesViewKey] = useState(0)
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme(window.localStorage))

  return (
    <>
      <div aria-hidden="true" className="window-drag-region">
        <div
          className="window-titlebar-toggle-region"
          onDoubleClick={() => { void window.api.invoke('window.toggleMaximize') }}
        />
      </div>
      <div className="grid h-screen w-screen max-w-full grid-cols-[11.125rem_minmax(0,1fr)] overflow-hidden bg-background text-foreground max-[980px]:grid-cols-[10.25rem_minmax(0,1fr)]">
        <aside className="flex h-screen min-h-0 flex-col border-r border-border bg-sidebar px-3 pb-3 pt-11">
            <div className="mb-5 flex items-center gap-2.5 px-2">
              <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-foreground text-background">
                <Blocks aria-hidden="true" size={16} />
              </div>
              <div className="grid min-w-0 gap-0.5">
                <strong className="whitespace-nowrap text-xs font-medium tracking-[-0.02em] text-foreground">Agent Dashboard</strong>
                <span className="truncate text-[10px] text-muted">{t('localIntelligence')}</span>
              </div>
            </div>

            <nav aria-label={t('mainLabel')} className="min-h-0 overflow-y-auto">
              {navigationGroups.map((navigationGroup, navigationGroupIndex) => (
                <div className={navigationGroupIndex === 0 ? '' : 'mt-4'} key={navigationGroup.labelKey}>
                  <p className="mb-1 px-2 text-[9px] font-medium uppercase tracking-[0.1em] text-muted/70">
                    {t(navigationGroup.labelKey)}
                  </p>
                  <div className="grid gap-0.5">
                    {navigationGroup.items.map(({ id, labelKey, icon: Icon }) => {
                      const active = activeView === id
                      return (
                        <div className="grid gap-0.5" key={id}>
                          <Button
                            aria-current={active ? 'page' : undefined}
                            className={`h-[2.125rem] justify-start gap-2 px-2 text-[13px] ${
                              active
                                ? 'bg-surface-hover text-foreground'
                                : 'text-muted hover:bg-surface-hover hover:text-foreground'
                            }`}
                            fullWidth
                            onPress={() => {
                              if (id === 'rules' && active) {
                                setActiveRulesSection('overview')
                                setRulesViewKey((current) => current + 1)
                              }
                              setActiveView(id)
                            }}
                            variant="ghost"
                          >
                            <Icon aria-hidden="true" size={16} />
                            <span>{t(labelKey)}</span>
                          </Button>
                          {id === 'rules' && active && (
                            <div aria-label={t('rulesLabel')} className="grid gap-0.5 pb-1 pt-2">
                              {rulesNavigationGroups.map((group, groupIndex) => (
                                <div
                                  aria-label={t(group.labelKey)}
                                  className="grid gap-0.5"
                                  key={group.labelKey}
                                  role="group"
                                >
                                  <span
                                    className={`px-8 text-[9px] font-medium tracking-[0.075em] text-muted/60 ${
                                      groupIndex === 0 ? '' : 'mt-2.5'
                                    }`}
                                  >
                                    {t(group.labelKey)}
                                  </span>
                                  {group.items.map((item) => (
                                    <Button
                                      aria-current={activeRulesSection === item.id ? 'page' : undefined}
                                      className={`h-7 justify-start px-8 text-[11px] ${
                                        activeRulesSection === item.id
                                          ? 'text-foreground'
                                          : 'text-muted hover:bg-surface-hover hover:text-foreground'
                                      }`}
                                      fullWidth
                                      key={item.id}
                                      onPress={() => setActiveRulesSection(item.id)}
                                      variant="ghost"
                                    >
                                      {t(item.labelKey)}
                                    </Button>
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </nav>

            <div className="mt-auto flex items-center gap-1 border-t border-border pt-3">
              <Button
                aria-current={activeView === 'settings' ? 'page' : undefined}
                className={`h-[2.125rem] min-w-0 flex-1 justify-start gap-2 px-2 text-[13px] ${
                  activeView === 'settings'
                    ? 'bg-surface-hover text-foreground'
                    : 'text-muted hover:bg-surface-hover hover:text-foreground'
                }`}
                fullWidth
                onPress={() => setActiveView('settings')}
                variant="ghost"
              >
                <Settings aria-hidden="true" size={16} />
                <span>{t('settings')}</span>
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
            className={`min-w-0 max-w-full overflow-x-hidden bg-background ${
              activeView === 'chat' || activeView === 'settings'
                ? 'overflow-y-hidden'
                : 'overflow-y-auto px-[clamp(1.75rem,5vw,4.5rem)] py-12'
            }`}
            key={activeView}
          >
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
                  setActiveRulesSection('overview')
                  setActiveView('rules')
                }}
                onPublishRules={(slug) => {
                  setSelectedPublishProject(slug)
                  setActiveRulesSection('generated')
                  setActiveView('rules')
                }}
              />
            )}
            {activeView === 'chat' && (
              <ChatView
                initialThreadId={selectedChatThreadId}
                onOpenGeneratedRules={(runId) => {
                  setActiveRulesSection('generated')
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
                onSectionChange={setActiveRulesSection}
                section={activeRulesSection}
              />
            )}
          </main>
        </div>
    </>
  )
}
