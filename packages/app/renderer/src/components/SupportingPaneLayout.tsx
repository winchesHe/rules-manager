import { Children } from 'react'
import type { CSSProperties, ReactNode } from 'react'

export type SupportingPaneWidth = 'sm' | 'md' | 'lg'
export type SupportingPaneCollapse = 'md' | 'lg' | 'xl'

const paneWidths: Record<SupportingPaneWidth, string> = {
  sm: '18rem',
  md: '20rem',
  lg: '22rem',
}

const collapseClasses: Record<SupportingPaneCollapse, string> = {
  md: '@min-[56rem]:grid-cols-[minmax(0,1fr)_var(--supporting-pane-width)]',
  lg: '@min-[64rem]:grid-cols-[minmax(0,1fr)_var(--supporting-pane-width)]',
  xl: '@min-[72rem]:grid-cols-[minmax(0,1fr)_var(--supporting-pane-width)]',
}

type PaneStyle = CSSProperties & {
  '--supporting-pane-width': string
}

export function SupportingPaneLayout({
  children,
  className = '',
  collapseAt = 'lg',
  pane,
  paneClassName = '',
  paneLabel,
  paneWidth = 'md',
}: {
  children?: ReactNode
  className?: string
  collapseAt?: SupportingPaneCollapse
  pane?: ReactNode
  paneClassName?: string
  paneLabel: string
  paneWidth?: SupportingPaneWidth
}) {
  const style: PaneStyle = {
    '--supporting-pane-width': paneWidths[paneWidth],
  }
  const slots = Children.toArray(children)
  const mainContent = pane === undefined ? slots[0] : children
  const paneContent = pane === undefined ? slots[1] : pane

  if (pane === undefined && slots.length !== 2) {
    throw new Error('SupportingPaneLayout requires main and pane content')
  }

  return (
    <div
      className="@container"
      data-collapse-at={collapseAt}
      data-pane-layout="true"
      data-pane-width={paneWidth}
    >
      <div
        className={`grid grid-cols-1 items-start gap-8 ${collapseClasses[collapseAt]} ${className}`.trim()}
        data-layout-grid="true"
        style={style}
      >
        <main className="min-w-0" data-layout-region="main">
          {mainContent}
        </main>
        <aside
          aria-label={paneLabel}
          className={`min-w-0 ${paneClassName}`.trim()}
          data-layout-region="pane"
        >
          {paneContent}
        </aside>
      </div>
    </div>
  )
}
