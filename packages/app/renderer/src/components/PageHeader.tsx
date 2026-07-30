import type { ReactNode } from 'react'

export function PageHeader({
  actions,
  description,
  eyebrow,
  title,
}: {
  actions?: ReactNode
  description?: string
  eyebrow?: string
  title: string
}) {
  return (
    <header className="mb-7 flex items-start justify-between gap-6">
      <div>
        {eyebrow && <p className="mb-2 text-xs font-bold text-muted">{eyebrow}</p>}
        <h1 className="text-3xl font-semibold text-foreground">{title}</h1>
        {description && <p className="mt-2 text-sm text-muted">{description}</p>}
      </div>
      {actions}
    </header>
  )
}
