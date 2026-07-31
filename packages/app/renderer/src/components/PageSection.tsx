import type { ReactNode } from 'react'

export function PageSection({
  action,
  children,
  className = '',
  description,
  title,
}: {
  action?: ReactNode
  children?: ReactNode
  className?: string
  description?: string
  title: string
}) {
  return (
    <section className={className} data-page-section="true">
      <header className="mb-3 flex items-end justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <h2 className="text-lg font-medium text-foreground">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {children}
    </section>
  )
}
