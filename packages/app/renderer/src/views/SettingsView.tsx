import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert,
  Button,
  Chip,
  ListBox,
  Select,
  Spinner,
  Switch,
} from '@heroui/react'
import {
  Boxes,
  CircleDot,
  ChevronRight,
  Code2,
  Languages,
  Info,
  Sparkles,
  Terminal,
} from 'lucide-react'
import { afterNextPaint } from '../async'
import { ProviderDetailsModal } from '../components/ProviderDetailsModal'
import { changeAppLocale, currentLocale, i18n, type AppLocale } from '../i18n'
import type { ThemeMode } from '../theme'
import type {
  LlmConfig,
  ProviderEntry,
  ProviderId,
  ProviderSnapshot,
  ProviderStatus,
} from '../types'

type SettingsSection = 'general' | 'providers' | 'about'

const sections = [
  { id: 'general', labelKey: 'sections.general', icon: Languages },
  { id: 'providers', labelKey: 'sections.providers', icon: Boxes },
  { id: 'about', labelKey: 'sections.about', icon: Info },
] satisfies Array<{ id: SettingsSection; labelKey: string; icon: typeof Boxes }>

const efforts: Array<{ id: LlmConfig['effort']; labelKey: string }> = [
  { id: 'low', labelKey: 'providers.efforts.low' },
  { id: 'medium', labelKey: 'providers.efforts.medium' },
  { id: 'high', labelKey: 'providers.efforts.high' },
  { id: 'xhigh', labelKey: 'providers.efforts.xhigh' },
  { id: 'max', labelKey: 'providers.efforts.max' },
]

type SettingsViewProps = {
  onThemeChange: (theme: ThemeMode) => void
  theme: ThemeMode
}

type GeneralContentProps = SettingsViewProps & {
  error: string | null
  locale: AppLocale
  onLocaleChange: (locale: string) => Promise<void>
}

type ProvidersContentProps = {
  busyProvider: ProviderId | null
  config: LlmConfig | null
  error: string | null
  loading: boolean
  onEffortChange: (effort: LlmConfig['effort']) => Promise<void>
  onFastModeChange: (enabled: boolean) => Promise<void>
  onOpenProvider: (provider: ProviderId) => void
  onToggleProvider: (provider: ProviderId, enabled: boolean) => Promise<void>
  savingDefaults: boolean
  snapshot: ProviderSnapshot
}

type ProviderRowProps = {
  busy: boolean
  entry: ProviderEntry
  onOpen: () => void
  onToggle: (enabled: boolean) => void
}

type SettingGroupProps = {
  children: ReactNode
  description: string
  title: string
}

type SettingRowProps = {
  control: ReactNode
  description: string
  label: ReactNode
}

export function SettingsView({ onThemeChange, theme }: SettingsViewProps) {
  const { t } = useTranslation('settings')
  const [activeSection, setActiveSection] = useState<SettingsSection>('general')
  const [locale, setLocale] = useState<AppLocale>(() => currentLocale())
  const [localeError, setLocaleError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<ProviderSnapshot>({
    entries: [],
    refreshing: false,
  })
  const [config, setConfig] = useState<LlmConfig | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<ProviderId | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyProvider, setBusyProvider] = useState<ProviderId | null>(null)
  const [savingDefaults, setSavingDefaults] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    const onUpdated = (value: unknown) => {
      if (current && isProviderSnapshot(value)) {
        setSnapshot(value)
        setError(value.error ?? null)
      }
    }
    const onFailed = (value: unknown) => {
      if (!current) return
      setError(readMessage(value, i18n.t('settings:providers.errors.refresh')))
      setSnapshot((previous) => ({ ...previous, refreshing: false }))
    }

    window.api.onEvent('settings.providers.updated', onUpdated)
    window.api.onEvent('settings.providers.failed', onFailed)
    void afterNextPaint(() =>
      Promise.all([
        window.api.invoke<ProviderSnapshot>('settings.providers.snapshot'),
        window.api.invoke<LlmConfig>('settings.load'),
      ]),
    )
      .then(([nextSnapshot, nextConfig]) => {
        if (!current) return
        setSnapshot(nextSnapshot)
        setConfig(nextConfig)
      })
      .catch((reason: unknown) => {
        if (current) setError(readMessage(reason, i18n.t('settings:providers.errors.load')))
      })
      .finally(() => {
        if (current) setLoading(false)
      })

    return () => {
      current = false
      window.api.offEvent('settings.providers.updated', onUpdated)
      window.api.offEvent('settings.providers.failed', onFailed)
    }
  }, [])

  const selectedEntry =
    snapshot.entries.find((entry) => entry.id === selectedProvider) ?? null
  async function selectLocale(value: string): Promise<void> {
    setLocaleError(null)
    try {
      const result = await changeAppLocale(value)
      setLocale(result.locale)
      if (!result.persisted) setLocaleError(t('general.saveFailed'))
    } catch {
      setLocaleError(t('general.saveFailed'))
    }
  }

  async function toggleProvider(provider: ProviderId, enabled: boolean): Promise<void> {
    setBusyProvider(provider)
    setError(null)
    try {
      const nextConfig = await window.api.invoke<LlmConfig>(
        'settings.providers.setEnabled',
        provider,
        enabled,
      )
      setConfig(nextConfig)
      setSnapshot((previous) => ({
        ...previous,
        refreshing: true,
        entries: previous.entries.map((entry) =>
          entry.id === provider
            ? {
                ...entry,
                enabled,
                status: enabled ? 'loading' : 'disabled',
              }
            : entry,
        ),
      }))
    } catch (reason: unknown) {
      setError(readMessage(reason, i18n.t('settings:providers.errors.update')))
    } finally {
      setBusyProvider(null)
    }
  }

  async function changeEffort(effort: LlmConfig['effort']): Promise<void> {
    if (!config) return
    setSavingDefaults(true)
    setError(null)
    try {
      const saved = await window.api.invoke<LlmConfig>('settings.save', {
        ...config,
        effort,
      })
      setConfig(saved)
    } catch (reason: unknown) {
      setError(readMessage(reason, i18n.t('settings:providers.errors.saveEffort')))
    } finally {
      setSavingDefaults(false)
    }
  }

  async function changeFastMode(fastMode: boolean): Promise<void> {
    if (!config) return
    setSavingDefaults(true)
    setError(null)
    try {
      const saved = await window.api.invoke<LlmConfig>('settings.save', {
        ...config,
        fastMode,
      })
      setConfig(saved)
    } catch (reason: unknown) {
      setError(readMessage(reason, i18n.t('settings:providers.errors.saveFastMode')))
    } finally {
      setSavingDefaults(false)
    }
  }

  function updateConfig(nextConfig: LlmConfig): void {
    setConfig(nextConfig)
    setSnapshot((previous) => ({
      ...previous,
      entries: previous.entries.map((entry) => ({
        ...entry,
        isDefault: entry.id === nextConfig.provider,
      })),
    }))
  }

  function updateEntry(nextEntry: ProviderEntry): void {
    setSnapshot((previous) => ({
      ...previous,
      entries: previous.entries.map((entry) =>
        entry.id === nextEntry.id ? nextEntry : entry,
      ),
    }))
  }

  let content: ReactNode
  if (activeSection === 'general') {
    content = (
      <GeneralContent
        error={localeError}
        locale={locale}
        onLocaleChange={selectLocale}
        onThemeChange={onThemeChange}
        theme={theme}
      />
    )
  } else if (activeSection === 'providers') {
    content = (
      <ProvidersContent
        busyProvider={busyProvider}
        config={config}
        error={error}
        loading={loading}
        onEffortChange={changeEffort}
        onFastModeChange={changeFastMode}
        onOpenProvider={setSelectedProvider}
        onToggleProvider={toggleProvider}
        savingDefaults={savingDefaults}
        snapshot={snapshot}
      />
    )
  } else {
    content = <AboutContent />
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[9.25rem_minmax(0,1fr)] overflow-hidden bg-background text-foreground">
      <aside className="flex min-h-0 flex-col border-r border-border bg-sidebar/45 px-3 pb-4 pt-8">
        <p className="mb-3 px-2 text-[10px] font-medium uppercase tracking-[0.09em] text-muted/70">
          {t('appGroup')}
        </p>
        <nav aria-label={t('navigationLabel')} className="grid gap-0.5">
          {sections.map(({ id, labelKey, icon: Icon }) => {
            const active = activeSection === id
            return (
              <Button
                aria-current={active ? 'page' : undefined}
                className={`h-8 justify-start gap-2 px-2 text-xs ${
                  active
                    ? 'bg-surface-hover text-foreground'
                    : 'text-muted hover:bg-surface-hover hover:text-foreground'
                }`}
                fullWidth
                key={id}
                onPress={() => setActiveSection(id)}
                variant="ghost"
              >
                <Icon aria-hidden="true" size={15} />
                {t(labelKey)}
              </Button>
            )
          })}
        </nav>
        <p className="mt-auto px-2 text-[10px] leading-4 text-muted/70">
          Agent Dashboard<br />{t('about.version')}
        </p>
      </aside>

      <main className="min-h-0 min-w-0 overflow-y-auto bg-background">
        <div className="mx-auto w-full max-w-4xl px-[clamp(2rem,5vw,4.5rem)] py-10">
          {content}
        </div>
      </main>

      <ProviderDetailsModal
        config={config}
        entry={selectedEntry}
        onClose={() => setSelectedProvider(null)}
        onConfigChange={updateConfig}
        onEntryChange={updateEntry}
        refreshing={snapshot.refreshing}
      />
    </div>
  )
}

function GeneralContent({
  error,
  locale,
  onLocaleChange,
  onThemeChange,
  theme,
}: GeneralContentProps) {
  const { t } = useTranslation('settings')
  return (
    <div>
      <h1 className="sr-only">{t('sections.general')}</h1>
      {error && (
        <Alert className="mb-5" status="danger">
          <Alert.Content>
            <Alert.Title>{t('general.saveFailed')}</Alert.Title>
          </Alert.Content>
        </Alert>
      )}
      <SettingGroup
        description={t('general.appearanceDescription')}
        title={t('general.appearance')}
      >
        <SettingRow
          control={(
            <Select
              aria-label={t('general.themeLabel')}
              className="w-40 shrink-0"
              onSelectionChange={(key) => onThemeChange(String(key) as ThemeMode)}
              selectedKey={theme}
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="dark" textValue={t('general.darkTheme')}>
                    {t('general.darkTheme')}
                  </ListBox.Item>
                  <ListBox.Item id="light" textValue={t('general.lightTheme')}>
                    {t('general.lightTheme')}
                  </ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          )}
          description={t('general.themeDescription')}
          label={t('general.theme')}
        />
        <SettingRow
          control={(
            <Select
              aria-label={t('general.languageLabel')}
              className="w-40 shrink-0"
              onSelectionChange={(key) => void onLocaleChange(String(key))}
              selectedKey={locale}
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="zh-CN" textValue="简体中文">
                    简体中文
                  </ListBox.Item>
                  <ListBox.Item id="en-US" textValue="English">
                    English
                  </ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          )}
          description={t('general.languageDescription')}
          label={t('general.language')}
        />
      </SettingGroup>
    </div>
  )
}

function ProvidersContent({
  busyProvider,
  config,
  error,
  loading,
  onEffortChange,
  onFastModeChange,
  onOpenProvider,
  onToggleProvider,
  savingDefaults,
  snapshot,
}: ProvidersContentProps) {
  const { t } = useTranslation('settings')
  return (
    <div>
      <h1 className="sr-only">{t('sections.providers')}</h1>

      {error && (
        <Alert className="mb-5" status="danger">
          <Alert.Content>
            <Alert.Title>{t('providers.attention')}</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <SettingGroup
        description={t('providers.description')}
        title={t('providers.title')}
      >
        {loading || snapshot.entries.length === 0 ? (
          <div className="grid min-h-44 place-items-center border-t border-border" data-loading="true">
            <div className="flex items-center gap-3 text-sm text-muted">
              <Spinner aria-label={t('providers.discoveringLabel')} color="accent" size="sm" />
              {t('providers.discovering')}
            </div>
          </div>
        ) : (
          snapshot.entries.map((entry) => (
            <ProviderRow
              busy={busyProvider === entry.id || snapshot.refreshing}
              entry={entry}
              key={entry.id}
              onOpen={() => onOpenProvider(entry.id)}
              onToggle={(enabled) => void onToggleProvider(entry.id, enabled)}
            />
          ))
        )}
      </SettingGroup>

      {config && (
        <SettingGroup
          description={t('providers.defaultsDescription')}
          title={t('providers.defaults')}
        >
          <SettingRow
            control={(
              <Select
                aria-label={t('providers.effortLabel')}
                className="w-40 shrink-0"
                isDisabled={savingDefaults}
                onSelectionChange={(key) =>
                  void onEffortChange(String(key) as LlmConfig['effort'])
                }
                selectedKey={config.effort}
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {efforts.map((effort) => (
                      <ListBox.Item
                        id={effort.id}
                        key={effort.id}
                        textValue={t(effort.labelKey)}
                      >
                        {t(effort.labelKey)}
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            )}
            description={t('providers.effortDescription', { provider: config.provider })}
            label={t('providers.effort')}
          />
          <SettingRow
            control={(
              <Switch
                aria-label={t('providers.fastModeLabel')}
                isDisabled={savingDefaults}
                isSelected={config.fastMode === true}
                onChange={(enabled) => void onFastModeChange(enabled)}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
            )}
            description={t('providers.fastModeDescription')}
            label={(
              <span className="flex items-center gap-2">
                {t('providers.fastMode')}
                <Chip size="sm" variant="soft">Claude · Codex</Chip>
              </span>
            )}
          />
        </SettingGroup>
      )}
    </div>
  )
}

function ProviderRow({ busy, entry, onOpen, onToggle }: ProviderRowProps) {
  const { t } = useTranslation('settings')
  const Icon = providerIcon(entry.id)
  return (
    <div className="flex min-h-20 items-center gap-4 border-t border-border py-4 transition-colors hover:bg-surface-hover/60">
      <button
        className="flex min-w-0 flex-1 items-center gap-4 text-left"
        onClick={onOpen}
        type="button"
      >
        <ChevronRight aria-hidden="true" className="shrink-0 text-muted" size={18} />
        <Icon aria-hidden="true" className="shrink-0 text-foreground" size={22} />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <strong className="text-sm font-medium text-foreground">{entry.label}</strong>
            {entry.isDefault && (
              <Chip color="accent" size="sm" variant="soft">
                {t('providers.default')}
              </Chip>
            )}
          </span>
          <span className="mt-1 flex items-center gap-2 text-sm text-muted">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${statusDotClass(entry.status)}`}
            />
            <span>{statusLabel(entry.status)}</span>
            {entry.models.length > 0 && (
              <>
                <span>·</span>
                <span>{t('providers.models', { count: entry.models.length })}</span>
              </>
            )}
          </span>
        </span>
      </button>

      <Switch
        aria-label={t(entry.enabled ? 'providers.disable' : 'providers.enable', {
          provider: entry.label,
        })}
        isDisabled={busy}
        isSelected={entry.enabled}
        onChange={onToggle}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </div>
  )
}

function providerIcon(provider: ProviderId): typeof Terminal {
  if (provider === 'claude') return Sparkles
  if (provider === 'opencode') return Code2
  if (provider === 'pi') return CircleDot
  return Terminal
}

function AboutContent() {
  const { t } = useTranslation('settings')
  return (
    <div>
      <h1 className="sr-only">{t('sections.about')}</h1>
      <SettingGroup
        description={t('about.description')}
        title={'Agent Dashboard'}
      >
        <SettingRow
          control={<span className="text-sm text-muted">{t('about.version')}</span>}
          description={t('about.versionDescription')}
          label={t('about.versionLabel')}
        />
        <SettingRow
          control={<span className="text-sm text-muted">{t('about.localValue')}</span>}
          description={t('about.localDescription')}
          label={t('about.localLabel')}
        />
      </SettingGroup>
    </div>
  )
}

function SettingGroup({ children, description, title }: SettingGroupProps) {
  return (
    <section className="mb-9 border-t border-border">
      <div className="py-4">
        <h2 className="text-base font-medium text-foreground">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
      </div>
      {children}
    </section>
  )
}

function SettingRow({ control, description, label }: SettingRowProps) {
  return (
    <div className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-6 border-t border-border py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

function statusLabel(status: ProviderStatus): string {
  if (status === 'available') return i18n.t('settings:providers.status.available')
  if (status === 'not-installed') return i18n.t('settings:providers.status.notInstalled')
  if (status === 'error') return i18n.t('settings:providers.status.error')
  if (status === 'disabled') return i18n.t('settings:providers.status.disabled')
  return i18n.t('settings:providers.status.loading')
}

function statusDotClass(status: ProviderStatus): string {
  if (status === 'available') return 'bg-success'
  if (status === 'error') return 'bg-danger'
  if (status === 'not-installed') return 'bg-warning'
  if (status === 'disabled') return 'bg-muted'
  return 'bg-primary'
}

function isProviderSnapshot(value: unknown): value is ProviderSnapshot {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'entries' in value &&
      Array.isArray(value.entries) &&
      'refreshing' in value,
  )
}

function readMessage(value: unknown, fallback: string): string {
  if (value instanceof Error) return value.message
  if (value && typeof value === 'object' && 'message' in value) {
    return String(value.message)
  }
  return typeof value === 'string' ? value : fallback
}
