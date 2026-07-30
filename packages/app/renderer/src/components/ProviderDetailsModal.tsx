import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert,
  Button,
  Chip,
  Input,
  Label,
  Modal,
  Spinner,
  TextField,
} from '@heroui/react'
import {
  Check,
  FileText,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { currentLocale, i18n } from '../i18n'
import { formatDateTime } from '../i18n/format'
import type {
  LlmConfig,
  ProviderDiagnostic,
  ProviderEntry,
  ProviderModel,
} from '../types'

export function ProviderDetailsModal({
  config,
  entry,
  refreshing,
  onClose,
  onConfigChange,
  onEntryChange,
}: {
  config: LlmConfig | null
  entry: ProviderEntry | null
  refreshing: boolean
  onClose: () => void
  onConfigChange: (config: LlmConfig) => void
  onEntryChange: (entry: ProviderEntry) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [diagnosticOpen, setDiagnosticOpen] = useState(false)
  const [diagnosticLoading, setDiagnosticLoading] = useState(false)
  const [diagnostic, setDiagnostic] = useState<ProviderDiagnostic | null>(null)

  useEffect(() => {
    setQuery('')
    setError(null)
    setDiagnostic(null)
  }, [entry?.id])

  useEffect(() => {
    if (!entry) return
    const onDiagnostic = (value: unknown) => {
      if (isDiagnostic(value) && value.provider === entry.id) {
        setDiagnostic(value)
        setDiagnosticLoading(false)
      }
    }
    const onFailed = (value: unknown) => {
      setDiagnosticLoading(false)
      setError(readMessage(value, i18n.t('settings:providers.errors.action')))
    }
    window.api.onEvent('settings.providers.diagnostic.done', onDiagnostic)
    window.api.onEvent('settings.providers.failed', onFailed)
    return () => {
      window.api.offEvent('settings.providers.diagnostic.done', onDiagnostic)
      window.api.offEvent('settings.providers.failed', onFailed)
    }
  }, [entry])

  const visibleModels = useMemo(() => {
    if (!entry) return []
    const normalized = query.trim().toLowerCase()
    if (!normalized) return entry.models
    return entry.models.filter((model) =>
      [model.label, model.id, model.description]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalized)),
    )
  }, [entry, query])

  const discovered = visibleModels.filter((model) => model.source !== 'custom')
  const custom = visibleModels.filter((model) => model.source === 'custom')

  async function selectModel(model: ProviderModel): Promise<void> {
    if (!entry) return
    setBusy(true)
    setError(null)
    try {
      const nextConfig = await window.api.invoke<LlmConfig>(
        'settings.providers.selectModel',
        entry.id,
        model.id,
      )
      onConfigChange(nextConfig)
    } catch (reason: unknown) {
      setError(readMessage(reason, i18n.t('settings:providers.errors.selectModel')))
    } finally {
      setBusy(false)
    }
  }

  async function removeModel(model: ProviderModel): Promise<void> {
    if (!entry) return
    setBusy(true)
    setError(null)
    try {
      const nextConfig = await window.api.invoke<LlmConfig>(
        'settings.providers.removeModel',
        entry.id,
        model.id,
      )
      onConfigChange(nextConfig)
      onEntryChange({
        ...entry,
        models: entry.models.filter((candidate) => candidate.id !== model.id),
      })
    } catch (reason: unknown) {
      setError(readMessage(reason, i18n.t('settings:providers.errors.removeModel')))
    } finally {
      setBusy(false)
    }
  }

  async function refresh(): Promise<void> {
    if (!entry) return
    setError(null)
    try {
      await window.api.invoke('settings.providers.refresh', entry.id)
    } catch (reason: unknown) {
      setError(readMessage(reason, i18n.t('settings:providers.errors.refreshProvider')))
    }
  }

  async function diagnose(): Promise<void> {
    if (!entry) return
    setDiagnosticOpen(true)
    setDiagnosticLoading(true)
    setDiagnostic(null)
    setError(null)
    try {
      const result = await window.api.invoke<{ started: boolean }>(
        'settings.providers.diagnostic',
        entry.id,
      )
      if (!result.started) {
        setDiagnosticLoading(false)
        setError(i18n.t('settings:providers.errors.busy'))
      }
    } catch (reason: unknown) {
      setDiagnosticLoading(false)
      setError(readMessage(reason, i18n.t('settings:providers.errors.diagnostic')))
    }
  }

  function mergeCustomModel(model: ProviderModel, nextConfig: LlmConfig): void {
    if (!entry) return
    onConfigChange(nextConfig)
    const existing = entry.models.findIndex((candidate) => candidate.id === model.id)
    onEntryChange({
      ...entry,
      models:
        existing >= 0
          ? entry.models.map((candidate) => (candidate.id === model.id ? model : candidate))
          : [...entry.models, model],
    })
  }

  const selectedModel =
    config && entry && config.provider === entry.id ? config.model : undefined

  return (
    <>
      <Modal isOpen={Boolean(entry)} onOpenChange={(open) => !open && onClose()}>
        <Modal.Backdrop>
          <Modal.Container placement="center" size="cover">
            <Modal.Dialog className="mx-auto max-h-[88vh] max-w-5xl overflow-hidden">
              <Modal.Header className="grid gap-5 border-b border-border pb-5">
                <div className="flex items-center justify-between">
                  <Modal.Heading>{entry?.label ?? t('settings:providers.modal.provider')}</Modal.Heading>
                  <Modal.CloseTrigger />
                </div>
                <TextField onChange={setQuery} value={query}>
                  <div className="relative">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-muted"
                      size={19}
                    />
                    <Input className="pl-10" fullWidth placeholder={t('settings:providers.modal.searchModels')} />
                  </div>
                </TextField>
              </Modal.Header>

              <Modal.Body className="min-h-[28rem] overflow-y-auto p-6">
                {error && (
                  <Alert className="mb-4" status="danger">
                    <Alert.Content>
                      <Alert.Title>{t('settings:providers.errors.action')}</Alert.Title>
                      <Alert.Description>{error}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                )}

                <ModelSection
                  busy={busy}
                  models={discovered}
                  onRemove={removeModel}
                  onSelect={selectModel}
                  selectedModel={selectedModel}
                  title={t('settings:providers.modal.discovered')}
                />
                {custom.length > 0 && (
                  <ModelSection
                    busy={busy}
                    models={custom}
                    onRemove={removeModel}
                    onSelect={selectModel}
                    selectedModel={selectedModel}
                    title={t('settings:providers.modal.custom')}
                  />
                )}
                {visibleModels.length === 0 && (
                  <div className="grid min-h-48 place-items-center text-sm text-muted">
                    {t('settings:providers.modal.emptySearch', { query })}
                  </div>
                )}
              </Modal.Body>

              <Modal.Footer className="shrink-0 border-t border-border px-6 py-4">
                <div className="flex w-full flex-wrap items-center justify-between gap-4">
                  <span className="min-w-0 text-sm text-muted">
                    {entry?.fetchedAt
                      ? t('settings:providers.modal.updatedAt', {
                          time: formatDateTime(entry.fetchedAt, currentLocale()),
                        })
                      : t('settings:providers.modal.notUpdated')}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-3">
                    <Button
                      isDisabled={!entry || busy}
                      onPress={() => setAddOpen(true)}
                      variant="secondary"
                    >
                      <Plus aria-hidden="true" size={17} />
                      {t('settings:providers.modal.addModel')}
                    </Button>
                    <Button
                      isDisabled={!entry || busy || refreshing}
                      onPress={() => void diagnose()}
                      variant="secondary"
                    >
                      <FileText aria-hidden="true" size={17} />
                      {t('settings:providers.modal.diagnostic')}
                    </Button>
                    <Button
                      className="bg-primary text-primary-foreground"
                      isDisabled={!entry || busy || refreshing}
                      onPress={() => void refresh()}
                    >
                      {refreshing ? (
                        <Spinner aria-label={t('settings:providers.modal.refreshing')} color="current" size="sm" />
                      ) : (
                        <RefreshCw aria-hidden="true" size={17} />
                      )}
                      {t('settings:providers.modal.refresh')}
                    </Button>
                  </div>
                </div>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <AddModelModal
        entry={entry}
        isOpen={addOpen}
        onAdded={mergeCustomModel}
        onOpenChange={setAddOpen}
      />

      <Modal isOpen={diagnosticOpen} onOpenChange={setDiagnosticOpen}>
        <Modal.Backdrop>
          <Modal.Container placement="center" size="lg">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{t('settings:providers.modal.diagnostic')}</Modal.Heading>
                <Modal.CloseTrigger />
              </Modal.Header>
              <Modal.Body className="min-h-56">
                {diagnosticLoading ? (
                  <div className="grid min-h-48 place-items-center">
                    <Spinner aria-label={t('settings:providers.modal.runningDiagnostic')} color="accent" size="lg" />
                  </div>
                ) : diagnostic ? (
                  <pre className="overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-background p-4 text-sm text-foreground">
                    {diagnostic.text}
                  </pre>
                ) : (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Title>{t('settings:providers.modal.diagnosticUnavailable')}</Alert.Title>
                      <Alert.Description>
                        {error ?? t('settings:providers.modal.diagnosticEmpty')}
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                )}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  )
}

function ModelSection({
  busy,
  models,
  onRemove,
  onSelect,
  selectedModel,
  title,
}: {
  busy: boolean
  models: ProviderModel[]
  onRemove: (model: ProviderModel) => Promise<void>
  onSelect: (model: ProviderModel) => Promise<void>
  selectedModel?: string
  title: string
}) {
  const { t } = useTranslation('settings')
  if (models.length === 0) return null
  return (
    <section className="mb-7">
      <div className="mb-3 flex items-center justify-between px-1 text-sm text-muted">
        <span>{title}</span>
        <span>{models.length}</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        {models.map((model, index) => {
          const selected = selectedModel === model.id
          return (
            <div
              className={`flex items-center gap-3 px-4 py-3 ${
                index > 0 ? 'border-t border-border' : ''
              }`}
              key={model.id}
            >
              <button
                className="grid min-w-0 flex-1 grid-cols-[minmax(9rem,auto)_minmax(8rem,auto)_minmax(0,1fr)] items-center gap-4 text-left hover:text-foreground"
                disabled={busy}
                onClick={() => void onSelect(model)}
                type="button"
              >
                <span className="truncate text-base text-foreground">{model.label}</span>
                <code className="truncate text-sm text-muted">{model.id}</code>
                <span className="truncate text-sm text-muted">
                  {model.description ?? model.source}
                </span>
              </button>
              {selected && (
                <Chip color="accent" size="sm" variant="soft">
                  <Check aria-hidden="true" size={13} />
                  {t('providers.default')}
                </Chip>
              )}
              {model.source === 'custom' && (
                <Button
                  aria-label={t('providers.modal.removeModel', { model: model.label })}
                  isDisabled={busy}
                  isIconOnly
                  onPress={() => void onRemove(model)}
                  variant="ghost"
                >
                  <Trash2 aria-hidden="true" size={16} />
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function AddModelModal({
  entry,
  isOpen,
  onAdded,
  onOpenChange,
}: {
  entry: ProviderEntry | null
  isOpen: boolean
  onAdded: (model: ProviderModel, config: LlmConfig) => void
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) {
      setId('')
      setLabel('')
      setError(null)
    }
  }, [isOpen])

  async function add(): Promise<void> {
    if (!entry) return
    setSaving(true)
    setError(null)
    try {
      const model = {
        id: id.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      }
      const config = await window.api.invoke<LlmConfig>(
        'settings.providers.addModel',
        entry.id,
        model,
      )
      onAdded(
        {
          id: model.id,
          label: model.label ?? model.id,
          source: 'custom',
        },
        config,
      )
      onOpenChange(false)
    } catch (reason: unknown) {
      setError(readMessage(reason, i18n.t('settings:providers.errors.addModel')))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container placement="center" size="md">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>{t('settings:providers.modal.addModel')}</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="grid gap-5">
              {error && (
                <Alert status="danger">
                  <Alert.Content>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}
              <TextField isRequired onChange={setId} value={id}>
                <Label>{t('settings:providers.modal.modelId')}</Label>
                <Input fullWidth placeholder={t('settings:providers.modal.modelIdPlaceholder')} />
              </TextField>
              <TextField onChange={setLabel} value={label}>
                <Label>{t('settings:providers.modal.label')}</Label>
                <Input fullWidth placeholder={t('settings:providers.modal.labelPlaceholder')} />
              </TextField>
            </Modal.Body>
            <Modal.Footer>
              <Button isDisabled={saving} onPress={() => onOpenChange(false)} variant="ghost">
                {t('common:actions.cancel')}
              </Button>
              <Button
                className="bg-primary text-primary-foreground"
                isDisabled={saving || !id.trim()}
                onPress={() => void add()}
              >
                {saving && <Spinner aria-label={t('settings:providers.modal.addingModel')} color="current" size="sm" />}
                {t('settings:providers.modal.addModel')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

function isDiagnostic(value: unknown): value is ProviderDiagnostic {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'provider' in value &&
      'checkedAt' in value &&
      'text' in value,
  )
}

function readMessage(value: unknown, fallback: string): string {
  if (value instanceof Error) return value.message
  if (value && typeof value === 'object' && 'message' in value) {
    return String(value.message)
  }
  return typeof value === 'string' ? value : fallback
}
