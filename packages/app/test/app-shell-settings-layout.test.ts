import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@jest/globals'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = path.join(appRoot, 'renderer/src')

describe('Agent Dashboard App Shell 与设置布局', () => {
  it('所有真实模块与设置共享固定高度侧栏', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'App.tsx'), 'utf8')

    expect(source).toContain('Agent Dashboard')
    expect(source).toContain('grid-cols-[12.5rem_minmax(0,1fr)]')
    expect(source).toContain("{t('workspace')}")
    expect(source).toContain("{t('knowledge')}")
    expect(source).toContain("{ id: 'overview', labelKey: 'scan'")
    expect(source).toContain("{ id: 'projects', labelKey: 'projects'")
    expect(source).toContain("{ id: 'chat', labelKey: 'chat'")
    expect(source).toContain("id: 'rules-management'")
    expect(source).toContain("id: 'agent-context'")
    expect(source).toContain("onPress={() => setActiveView('settings')}")
    expect(source).toContain("activeView === 'chat' || activeView === 'settings'")
    expect(source).toContain('<SettingsView')
    expect(source).not.toContain('<SettingsView onBack=')
    expect(source).not.toContain('text-success')
    expect(source).toContain("theme === 'dark' ? t('switchLight') : t('switchDark')")
    expect(source).toContain("const nextTheme = theme === 'dark' ? 'light' : 'dark'")
    expect(source).toContain('<Sun aria-hidden="true"')
    expect(source).toContain('<Moon aria-hidden="true"')
  })

  it('侧栏可收起为图标栏，并按状态在标题栏收起、底部展开', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'App.tsx'), 'utf8')
    const toggle = fs.readFileSync(
      path.join(rendererRoot, 'components/SidebarToggle.tsx'),
      'utf8',
    )

    expect(source).toContain('const [sidebarCollapsed, setSidebarCollapsed] = useState(false)')
    expect(source).toContain("? 'grid-cols-[5.25rem_minmax(0,1fr)]'")
    expect(source).toContain("'grid-cols-[12.5rem_minmax(0,1fr)] max-[980px]:grid-cols-[11.5rem_minmax(0,1fr)]'")
    expect(source).toContain('bg-sidebar pb-3 pt-14')
    expect(source).toContain('!sidebarCollapsed && (')
    expect(source).toContain('className="sidebar-titlebar-toggle" data-sidebar-toggle-top')
    expect(source).toContain('data-sidebar-toggle-top')
    expect(source).toContain('collapsed={false}')
    expect(source).toContain('onToggle={() => setSidebarCollapsed(true)}')
    expect(source).toContain('sidebarCollapsed && (')
    expect(source).toContain('data-sidebar-toggle-bottom')
    expect(source).toContain('onToggle={() => setSidebarCollapsed(false)}')
    expect(source).toContain('className={`min-w-0 max-w-full')
    expect(source).not.toContain('SidebarToggleProvider')
    expect(source.indexOf('data-sidebar-toggle-top'))
      .toBeLessThan(source.indexOf('Agent Dashboard</strong>'))
    expect(source.indexOf('data-sidebar-toggle-bottom'))
      .toBeLessThan(source.indexOf('gap-1 border-t border-border pt-3'))
    expect(toggle).toContain("collapsed ? t('expandSidebar') : t('collapseSidebar')")
    expect(toggle).toContain('<PanelLeftOpen aria-hidden="true"')
    expect(toggle).toContain('<PanelLeftClose aria-hidden="true"')
    expect(toggle).not.toContain('data-sidebar-toggle-leading')
    expect(toggle).not.toContain('bg-border')
    expect(source).toContain("sidebarCollapsed ? 'justify-center px-0' : 'justify-start gap-2 px-2'")
    expect(source).toContain('!sidebarCollapsed && expanded && (')
    expect(source).toContain('setSidebarCollapsed(false)')
    expect(source).toContain("sidebarCollapsed ? 'grid justify-items-center' : 'flex items-center'")
  })

  it('设置使用内嵌分区与行式控件，并承接真实主题配置', () => {
    const source = fs.readFileSync(
      path.join(rendererRoot, 'views/SettingsView.tsx'),
      'utf8',
    )

    expect(source).toContain('grid h-full min-h-0 grid-cols-[9.25rem_minmax(0,1fr)]')
    expect(source).toContain('function SettingGroup')
    expect(source).toContain('function SettingRow')
    expect(source).toContain("id: 'general'")
    expect(source).toContain("id: 'providers'")
    expect(source).toContain("id: 'about'")
    expect(source).toContain('onThemeChange: (theme: ThemeMode) => void')
    expect(source).toContain('selectedKey={theme}')
    expect(source).toContain('selectedKey={locale}')
    expect(source).toContain("'settings.providers.setEnabled'")
    expect(source).toContain("'settings.save'")
    expect(source).not.toContain('onBack')
    expect(source).not.toContain('<Card')
  })

  it('窗口与文档标题使用新产品名，内部包名不随 UI 改名', () => {
    const main = fs.readFileSync(path.join(appRoot, 'main/index.ts'), 'utf8')
    const html = fs.readFileSync(path.join(appRoot, 'renderer/index.html'), 'utf8')
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'),
    ) as { name: string }

    expect(main).toContain("app.setName('Agent Dashboard')")
    expect(main).toContain("title: 'Agent Dashboard'")
    expect(main).toContain("backgroundColor: '#f4f5f7'")
    expect(html).toContain('<title>Agent Dashboard</title>')
    expect(packageJson.name).toBe('@memory-manager/app')
  })
})
