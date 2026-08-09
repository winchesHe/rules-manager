import type { ReactNode } from 'react'
import { SidebarToggle } from './SidebarToggle'

export function PageHeader({
  actions,
  className = 'mb-7',
  description,
  eyebrow,
  title,
}: {
  actions?: ReactNode
  className?: string
  description?: string
  eyebrow?: string
  title: string
}) {
  return (
    <header
      className={`flex flex-wrap items-start justify-between gap-6 ${className}`.trim()}
      data-page-header="true"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <SidebarToggle className="mt-0.5" />
        <div className="min-w-0 flex-1">
          {eyebrow && <p className="mb-2 text-xs font-bold text-muted">{eyebrow}</p>}
          <h1 className="text-3xl font-semibold text-foreground">{title}</h1>
          {description && <p className="mt-2 text-sm text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </header>
  )
}
