import { useEffect, useState } from 'react'
import { Button, Tooltip } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import {
  FolderKanban,
  Moon,
  ScanSearch,
  ScrollText,
  Settings,
  Sun,
} from 'lucide-react'
import { OverviewView } from './views/OverviewView'
import { ProjectsView } from './views/ProjectsView'
import { RulesView } from './views/RulesView'
import type { RulesSection } from './views/RulesView'
import { SettingsView } from './views/SettingsView'

type ThemeMode = 'dark' | 'light'
type ContentViewId = 'overview' | 'projects' | 'rules'
type ViewId = ContentViewId | 'settings'

const navigation = [
  { id: 'overview', labelKey: 'scan', icon: ScanSearch },
  { id: 'projects', labelKey: 'projects', icon: FolderKanban },
  { id: 'rules', labelKey: 'rules', icon: ScrollText },
] satisfies Array<{ id: ContentViewId; labelKey: string; icon: typeof ScanSearch }>

const rulesNavigation: Array<{ id: RulesSection; labelKey: string }> = [
  { id: 'overview', labelKey: 'rulesOverview' },
  { id: 'agents', labelKey: 'agentInstructions' },
  { id: 'generated', labelKey: 'generatedRules' },
  { id: 'history', labelKey: 'generationHistory' },
]

export function App() {
  const { t } = useTranslation('navigation')
  const [activeView, setActiveView] = useState<ViewId>('overview')
  const [previousView, setPreviousView] = useState<ContentViewId>('overview')
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string | null>(null)
  const [selectedProjectTab, setSelectedProjectTab] = useState<'sessions' | 'rules'>('sessions')
  const [selectedRulesProject, setSelectedRulesProject] = useState<string | null>(null)
  const [activeRulesSection, setActiveRulesSection] = useState<RulesSection>('overview')
  const [rulesViewKey, setRulesViewKey] = useState(0)
  const [theme, setTheme] = useState<ThemeMode>('dark')

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('dark', 'light')
    root.classList.add(theme)
  }, [theme])

  function openSettings(): void {
    if (activeView !== 'settings') setPreviousView(activeView)
    setActiveView('settings')
  }

  return (
    <>
      <div aria-hidden="true" className="window-drag-region" />
      {activeView === 'settings' ? (
        <SettingsView onBack={() => setActiveView(previousView)} />
      ) : (
        <div className="grid h-screen w-screen max-w-full grid-cols-[14rem_minmax(0,1fr)] overflow-hidden bg-background text-foreground max-[980px]:grid-cols-[11.75rem_minmax(0,1fr)]">
          <aside className="flex h-screen flex-col border-r border-border bg-sidebar px-4 pb-5 pt-11">
            <div className="mb-2 grid size-9 place-items-center rounded-lg bg-primary font-extrabold text-primary-foreground">
              M
            </div>
            <div className="mb-8 grid gap-1">
              <strong className="text-sm text-foreground">Memory Manager</strong>
              <span className="text-xs text-muted">{t('workspace')}</span>
            </div>

            <nav aria-label={t('mainLabel')} className="grid gap-1">
              {navigation.map(({ id, labelKey, icon: Icon }) => {
                const active = activeView === id
                return (
                  <div className="grid gap-1" key={id}>
                    <Button
                      aria-current={active ? 'page' : undefined}
                      className={`justify-start gap-2.5 px-3 text-sm ${
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
                      <Icon aria-hidden="true" className={active ? 'text-primary' : undefined} size={17} />
                      <span>{t(labelKey)}</span>
                    </Button>
                    {id === 'rules' && active && (
                      <div
                        aria-label={t('rulesLabel')}
                        className="ml-5 grid gap-0.5 border-l border-border pl-2"
                      >
                        {rulesNavigation.map((item) => (
                          <Button
                            aria-current={activeRulesSection === item.id ? 'page' : undefined}
                            className={`h-8 justify-start px-2 text-xs ${
                              activeRulesSection === item.id
                                ? 'bg-surface-hover text-primary'
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
                    )}
                  </div>
                )
              })}
            </nav>

            <div className="mt-auto flex items-center gap-1">
              <Button
                className="min-w-0 flex-1 justify-start gap-2.5 px-3 text-sm text-muted hover:bg-surface-hover hover:text-foreground"
                onPress={openSettings}
                variant="ghost"
              >
                <Settings aria-hidden="true" size={17} />
                <span>{t('settings')}</span>
              </Button>
              <Tooltip>
                <Button
                  aria-label={theme === 'dark' ? t('switchLight') : t('switchDark')}
                  className="shrink-0 text-muted hover:bg-surface-hover hover:text-foreground"
                  isIconOnly
                  onPress={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
                  variant="ghost"
                >
                  {theme === 'dark' ? (
                    <Sun aria-hidden="true" size={17} />
                  ) : (
                    <Moon aria-hidden="true" size={17} />
                  )}
                </Button>
                <Tooltip.Content>
                  {theme === 'dark' ? t('switchLight') : t('switchDark')}
                </Tooltip.Content>
              </Tooltip>
            </div>
          </aside>

          <main
            className="min-w-0 max-w-full overflow-x-hidden overflow-y-auto bg-background px-[clamp(1.75rem,5vw,4.5rem)] py-12"
            key={activeView}
          >
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
              />
            )}
            {activeView === 'rules' && (
                  <RulesView
                    initialProjectSlug={selectedRulesProject}
                    key={rulesViewKey}
                    onInitialProjectHandled={() => setSelectedRulesProject(null)}
                onOpenProjectRules={(slug) => {
                  setSelectedProjectSlug(slug ?? null)
                      setSelectedProjectTab('rules')
                      setActiveView('projects')
                    }}
                    onSectionChange={setActiveRulesSection}
                    section={activeRulesSection}
                  />
            )}
          </main>
        </div>
      )}
    </>
  )
}
