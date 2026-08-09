import { Alert, Skeleton, Spinner } from '@heroui/react'
import { FolderKanban, ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function ViewLoading({ label }: { label: string }) {
  return (
    <div className="grid min-h-[60vh] place-items-center" data-loading="true">
      <Spinner aria-label={label} color="accent" size="lg" />
    </div>
  )
}

export function TablePageSkeleton({
  columns = 5,
  label,
  rows = 8,
}: {
  columns?: 5 | 6
  label: string
  rows?: number
}) {
  const template = columns === 6
    ? 'minmax(12rem,2fr) minmax(8rem,1.2fr) repeat(4,minmax(4rem,.55fr))'
    : 'minmax(12rem,2fr) minmax(8rem,1.2fr) repeat(3,minmax(4rem,.55fr))'

  return (
    <div aria-busy="true" aria-label={label} data-loading="skeleton">
      <div className="grid min-h-11 items-center gap-5 bg-surface-hover px-5" style={{ gridTemplateColumns: template }}>
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton
            animationType="shimmer"
            className={`h-3 rounded-md ${index === 0 ? 'w-24' : 'w-14'}`}
            key={`header-${index}`}
          />
        ))}
      </div>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          className="grid min-h-[3.55rem] items-center gap-5 border-t border-border px-5"
          key={`row-${rowIndex}`}
          style={{ gridTemplateColumns: template }}
        >
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton
              animationType="shimmer"
              className={`h-3 rounded-md ${
                columnIndex === 0
                  ? rowIndex % 3 === 0 ? 'w-40' : 'w-32'
                  : columnIndex === 1 ? 'w-24' : 'w-12'
              }`}
              key={`cell-${columnIndex}`}
            />
          ))}
        </div>
      ))}
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
