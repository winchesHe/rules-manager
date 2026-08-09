import { createContext, useContext, type ReactNode } from 'react'
import { Button, Tooltip } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'

type SidebarToggleContextValue = {
  collapsed: boolean
  onToggle: () => void
}

const SidebarToggleContext = createContext<SidebarToggleContextValue | null>(null)

export function SidebarToggleProvider({
  children,
  collapsed,
  onToggle,
}: SidebarToggleContextValue & { children: ReactNode }) {
  return (
    <SidebarToggleContext.Provider value={{ collapsed, onToggle }}>
      {children}
    </SidebarToggleContext.Provider>
  )
}

export function SidebarToggle({ className = '' }: { className?: string }) {
  const { t } = useTranslation('navigation')
  const context = useContext(SidebarToggleContext)

  if (!context) return null

  const label = context.collapsed ? t('expandSidebar') : t('collapseSidebar')

  return (
    <div
      className={`window-no-drag flex shrink-0 items-center gap-3 ${className}`.trim()}
      data-sidebar-toggle-leading
    >
      <Tooltip>
        <Button
          aria-label={label}
          className="size-8 min-w-8 rounded-md p-0 text-muted hover:bg-surface-hover hover:text-foreground"
          isIconOnly
          onPress={context.onToggle}
          variant="ghost"
        >
          {context.collapsed ? (
            <PanelLeftOpen aria-hidden="true" size={16} />
          ) : (
            <PanelLeftClose aria-hidden="true" size={16} />
          )}
        </Button>
        <Tooltip.Content>{label}</Tooltip.Content>
      </Tooltip>
      <span aria-hidden="true" className="h-5 w-px bg-border" />
    </div>
  )
}
