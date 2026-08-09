import type { CSSProperties, ReactNode } from 'react'

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
    <div
      className={`ux-page-transition ${className}`.trim()}
      data-transition-key={transitionKey}
      key={transitionKey}
    >
      {children}
    </div>
  )
}

export function EntranceTransition({
  children,
  className = '',
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: 0 | 50 | 110
}) {
  return (
    <div
      className={`ux-entrance-transition ${className}`.trim()}
      style={{ '--ux-enter-delay': `${delay}ms` } as CSSProperties}
    >
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
      data-transition-key={transitionKey}
    >
      {children}
    </div>
  )
}
