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
    expect(source).toContain('grid-cols-[11.125rem_minmax(0,1fr)]')
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

  it('侧栏可收起为可操作的图标栏，并从侧栏底部按钮恢复', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'App.tsx'), 'utf8')

    expect(source).toContain('const [sidebarCollapsed, setSidebarCollapsed] = useState(false)')
    expect(source).toContain("? 'grid-cols-[3.5rem_minmax(0,1fr)]'")
    expect(source).toContain("'grid-cols-[11.125rem_minmax(0,1fr)] max-[980px]:grid-cols-[10.25rem_minmax(0,1fr)]'")
    expect(source).toContain("sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')")
    expect(source).toContain('onPress={() => setSidebarCollapsed((current) => !current)}')
    expect(source).toContain('<PanelLeftOpen aria-hidden="true"')
    expect(source).toContain('<PanelLeftClose aria-hidden="true"')
    expect(source).toContain('className="size-[2.125rem] min-w-[2.125rem] shrink-0 text-muted')
    expect(source).toContain('className={`relative min-w-0 max-w-full')
    expect(source.indexOf('aria-label={sidebarCollapsed ? t(\'expandSidebar\')'))
      .toBeLessThan(source.indexOf('<main'))
    expect(source).not.toContain('sidebar-collapse-toggle')
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
