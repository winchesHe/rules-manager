import type { ReactNode } from 'react'

export function PageTransition({
  children,
  className = '',
  transitionKey,
}: {
  children: ReactNode
  className?: string
  transitionKey: string
}) {
  return (
    <div className={`ux-page-transition ${className}`.trim()} key={transitionKey}>
      {children}
    </div>
  )
}

export function FilterTransition({
  busy = false,
  children,
  transitionKey,
}: {
  busy?: boolean
  children: ReactNode
  transitionKey: string
}) {
  return (
    <div
      aria-busy={busy}
      className="ux-filter-transition"
      data-busy={busy}
      key={transitionKey}
    >
      {children}
    </div>
  )
}
