import type { ReactNode } from 'react'

export type PageArchetype = 'collection' | 'dashboard' | 'task' | 'workspace'
export type PageWidth = 'narrow' | 'wide' | 'fluid'
export type PageDensity = 'comfortable' | 'compact'
export type PagePadding = 'page' | 'none'
export type PageScroll = 'page' | 'contained'

const widthClasses: Record<PageWidth, string> = {
  narrow: 'mx-auto w-full max-w-[54rem]',
  wide: 'mx-auto w-full max-w-[81rem]',
  fluid: 'w-full min-w-0',
}

const densityClasses: Record<PageDensity, string> = {
  comfortable: 'space-y-7',
  compact: 'space-y-6',
}

const paddingClasses: Record<PagePadding, string> = {
  page: 'px-[clamp(0.5rem,1vw,1rem)]',
  none: 'px-0',
}

const scrollClasses: Record<PageScroll, string> = {
  page: 'min-w-0',
  contained: 'min-h-0 overflow-hidden',
}

export function PageShell({
  archetype,
  children,
  className = '',
  density = 'comfortable',
  padding = 'page',
  scroll = 'page',
  width = 'wide',
}: {
  archetype: PageArchetype
  children?: ReactNode
  className?: string
  density?: PageDensity
  padding?: PagePadding
  scroll?: PageScroll
  width?: PageWidth
}) {
  return (
    <div
      className={`${widthClasses[width]} ${densityClasses[density]} ${paddingClasses[padding]} ${scrollClasses[scroll]} ${className}`.trim()}
      data-density={density}
      data-layout={archetype}
      data-padding={padding}
      data-page-shell="true"
      data-scroll-owner={scroll}
      data-width={width}
    >
      {children}
    </div>
  )
}
