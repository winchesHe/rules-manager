import { Button, Tooltip } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { PanelLeft, PanelLeftOpen } from 'lucide-react'

export function SidebarToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation('navigation')
  const label = collapsed ? t('expandSidebar') : t('collapseSidebar')

  return (
    <Tooltip>
      <Button
        aria-label={label}
        className="size-[2.125rem] min-w-[2.125rem] rounded-md p-0 text-muted hover:bg-surface-hover hover:text-foreground"
        isIconOnly
        onPress={onToggle}
        variant="ghost"
      >
        {collapsed ? (
          <PanelLeftOpen aria-hidden="true" size={16} />
        ) : (
          <PanelLeft aria-hidden="true" size={16} />
        )}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  )
}
