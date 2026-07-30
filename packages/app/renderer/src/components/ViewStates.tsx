import { Alert, Spinner } from '@heroui/react'
import { FolderKanban, ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function ViewLoading({ label }: { label: string }) {
  return (
    <div className="grid min-h-[60vh] place-items-center" data-loading="true">
      <Spinner aria-label={label} color="accent" size="lg" />
    </div>
  )
}

export function ViewError({ message, title }: { message: string; title: string }) {
  return (
    <Alert status="danger">
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        <Alert.Description>{message}</Alert.Description>
      </Alert.Content>
    </Alert>
  )
}

export function EmptyProjects() {
  const { t } = useTranslation('projects')
  return (
    <div className="grid min-h-60 place-items-center content-center gap-3 text-sm text-muted">
      <FolderKanban aria-hidden="true" size={24} />
      <span>{t('empty.projects')}</span>
    </div>
  )
}

export function EmptyRules() {
  const { t } = useTranslation('projects')
  return (
    <div className="grid min-h-60 place-items-center content-center gap-3 text-sm text-muted">
      <ScrollText aria-hidden="true" size={24} />
      <span>{t('empty.rules')}</span>
    </div>
  )
}
