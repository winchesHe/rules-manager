import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert,
  Button,
  Card,
  Chip,
  ListBox,
  Select,
  Spinner,
  Switch,
} from '@heroui/react'
import {
  ArrowLeft,
  Boxes,
  ChevronRight,
  Languages,
  Info,
  Sparkles,
  Terminal,
} from 'lucide-react'
import { afterNextPaint } from '../async'
import { ProviderDetailsModal } from '../components/ProviderDetailsModal'
import { changeAppLocale, currentLocale, i18n, type AppLocale } from '../i18n'
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

export function SettingsView({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation(['settings', 'common'])
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
  const ActiveIcon =
    activeSection === 'general' ? Languages : activeSection === 'providers' ? Boxes : Info
  const activeLabel = t(`settings:sections.${activeSection}`)

  async function selectLocale(value: string): Promise<void> {
    setLocaleError(null)
    try {
      const result = await changeAppLocale(value)
      setLocale(result.locale)
      if (!result.persisted) setLocaleError(t('settings:general.saveFailed'))
    } catch {
      setLocaleError(t('settings:general.saveFailed'))
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

  return (
    <div className="grid h-screen grid-cols-[15rem_minmax(0,1fr)] overflow-hidden bg-background text-foreground">
      <aside className="flex h-screen flex-col border-r border-border bg-sidebar">
        <div className="border-b border-border px-4 pb-6 pt-10">
          <Button
            className="justify-start gap-2 px-3 text-muted hover:bg-surface-hover hover:text-foreground"
            fullWidth
            onPress={onBack}
            variant="ghost"
          >
            <ArrowLeft aria-hidden="true" size={18} />
            {t('common:actions.back')}
          </Button>
        </div>

        <div className="overflow-y-auto px-4 py-6">
          <p className="mb-3 px-3 text-sm font-medium text-muted">
            {t('settings:appGroup')}
          </p>
          <nav aria-label={t('settings:navigationLabel')} className="grid gap-1">
            {sections.map(({ id, labelKey, icon: Icon }) => {
              const active = activeSection === id
              return (
                <Button
                  aria-current={active ? 'page' : undefined}
                  className={`justify-start gap-3 px-3 text-base ${
                    active
                      ? 'bg-surface-hover text-foreground'
                      : 'text-muted hover:bg-surface-hover hover:text-foreground'
                  }`}
                  fullWidth
                  key={id}
                  onPress={() => setActiveSection(id)}
                  variant="ghost"
                >
                  <Icon
                    aria-hidden="true"
                    className={active ? 'text-primary' : undefined}
                    size={19}
                  />
                  {t(`settings:${labelKey}`)}
                </Button>
              )
            })}
          </nav>
        </div>
      </aside>

      <main className="min-w-0 overflow-y-auto bg-background">
        <header className="sticky top-0 z-10 flex h-20 items-center gap-4 border-b border-border bg-background px-10">
          <ActiveIcon aria-hidden="true" className="text-muted" size={22} />
          <h1 className="text-2xl font-medium text-foreground">{activeLabel}</h1>
        </header>

        {activeSection === 'general' ? (
          <GeneralContent
            error={localeError}
            locale={locale}
            onLocaleChange={selectLocale}
          />
        ) : activeSection === 'providers' ? (
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
        ) : (
          <AboutContent />
        )}
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
}: {
  error: string | null
  locale: AppLocale
  onLocaleChange: (locale: string) => Promise<void>
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="mx-auto w-full max-w-5xl px-10 py-8">
      <p className="mb-4 text-sm text-muted">{t('general.description')}</p>
      {error && (
        <Alert className="mb-5" status="danger">
          <Alert.Content>
            <Alert.Title>{t('general.saveFailed')}</Alert.Title>
          </Alert.Content>
        </Alert>
      )}
      <Card className="border border-border bg-surface shadow-none">
        <Card.Content className="flex min-h-28 items-center justify-between gap-8 p-5">
          <div>
            <p className="font-medium text-foreground">{t('general.language')}</p>
            <p className="mt-1 text-sm text-muted">{t('general.languageDescription')}</p>
          </div>
          <Select
            aria-label={t('general.languageLabel')}
            className="w-52 shrink-0"
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
        </Card.Content>
      </Card>
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
}: {
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
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="mx-auto w-full max-w-5xl px-10 py-8">
      <p className="mb-4 text-sm text-muted">{t('providers.title')}</p>

      {error && (
        <Alert className="mb-5" status="danger">
          <Alert.Content>
            <Alert.Title>{t('providers.attention')}</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        {loading || snapshot.entries.length === 0 ? (
          <div className="grid min-h-56 place-items-center" data-loading="true">
            <div className="flex items-center gap-3 text-sm text-muted">
              <Spinner aria-label={t('providers.discoveringLabel')} color="accent" size="sm" />
              {t('providers.discovering')}
            </div>
          </div>
        ) : (
          snapshot.entries.map((entry, index) => (
            <ProviderRow
              busy={busyProvider === entry.id || snapshot.refreshing}
              entry={entry}
              key={entry.id}
              onOpen={() => onOpenProvider(entry.id)}
              onToggle={(enabled) => void onToggleProvider(entry.id, enabled)}
              separated={index > 0}
            />
          ))
        )}
      </div>

      {config && (
        <section className="mt-8">
          <p className="mb-4 text-sm text-muted">{t('providers.defaults')}</p>
          <Card className="border border-border bg-surface shadow-none">
            <Card.Content className="p-0">
              <div className="flex min-h-28 items-center justify-between gap-8 p-5">
                <div>
                  <p className="font-medium text-foreground">{t('providers.effort')}</p>
                  <p className="mt-1 text-sm text-muted">
                    {t('providers.effortDescription', { provider: config.provider })}
                  </p>
                </div>
                <Select
                  aria-label={t('providers.effortLabel')}
                  className="w-52 shrink-0"
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
              </div>
              <div className="flex min-h-28 items-center justify-between gap-8 border-t border-border p-5">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-foreground">{t('providers.fastMode')}</p>
                    <Chip size="sm" variant="soft">
                      Claude · Codex
                    </Chip>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {t('providers.fastModeDescription')}
                  </p>
                </div>
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
              </div>
            </Card.Content>
          </Card>
        </section>
      )}
    </div>
  )
}

function ProviderRow({
  busy,
  entry,
  onOpen,
  onToggle,
  separated,
}: {
  busy: boolean
  entry: ProviderEntry
  onOpen: () => void
  onToggle: (enabled: boolean) => void
  separated: boolean
}) {
  const { t } = useTranslation('settings')
  const Icon = entry.id === 'claude' ? Sparkles : Terminal
  return (
    <div
      className={`flex min-h-24 items-center gap-4 px-6 transition-colors hover:bg-surface-hover ${
        separated ? 'border-t border-border' : ''
      }`}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-4 text-left"
        onClick={onOpen}
        type="button"
      >
        <ChevronRight aria-hidden="true" className="shrink-0 text-muted" size={18} />
        <Icon aria-hidden="true" className="shrink-0 text-foreground" size={22} />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <strong className="text-lg font-medium text-foreground">{entry.label}</strong>
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

function AboutContent() {
  const { t } = useTranslation('settings')
  return (
    <div className="mx-auto w-full max-w-5xl px-10 py-8">
      <p className="mb-4 text-sm text-muted">{t('about.title')}</p>
      <Card className="border border-border bg-surface shadow-none">
        <Card.Content className="grid gap-1 p-6">
          <strong className="text-lg text-foreground">Memory Manager</strong>
          <span className="text-sm text-muted">{t('about.version')}</span>
        </Card.Content>
      </Card>
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
