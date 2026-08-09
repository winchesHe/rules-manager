import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@jest/globals'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('window drag region', () => {
  it('为 hiddenInset 窗口提供拖动带并保护交互控件', () => {
    const appSource = fs.readFileSync(
      path.join(appRoot, 'renderer/src/App.tsx'),
      'utf8',
    )
    const styles = fs.readFileSync(
      path.join(appRoot, 'renderer/src/styles.css'),
      'utf8',
    )
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')
    const toggleSource = fs.readFileSync(
      path.join(appRoot, 'renderer/src/components/SidebarToggle.tsx'),
      'utf8',
    )
    const controlsSource = fs.readFileSync(
      path.join(appRoot, 'renderer/src/components/WindowControls.tsx'),
      'utf8',
    )
    const mainSource = fs.readFileSync(path.join(appRoot, 'main/index.ts'), 'utf8')

    expect(appSource).toContain('className="window-drag-region"')
    expect(appSource).toContain('className="window-titlebar-toggle-region"')
    expect(appSource).toContain("window.api.invoke('window.toggleMaximize')")
    expect(styles).toMatch(/\.window-drag-region\s*\{[^}]*-webkit-app-region:\s*drag/s)
    expect(styles).toMatch(/\.window-titlebar-toggle-region\s*\{[^}]*height:\s*0\.75rem[^}]*-webkit-app-region:\s*no-drag/s)
    expect(styles).toMatch(/\.window-controls\s*\{[^}]*top:\s*0\.8125rem[^}]*left:\s*1rem[^}]*z-index:\s*1002[^}]*gap:\s*0\.5rem[^}]*-webkit-app-region:\s*no-drag/s)
    expect(styles).toMatch(/\.window-control\s*\{[^}]*width:\s*0\.75rem[^}]*height:\s*0\.75rem[^}]*border-radius:\s*999px/s)
    expect(styles).toContain('background: #ff5f57')
    expect(styles).toContain('background: #febc2e')
    expect(styles).toContain('background: #28c840')
    expect(styles).toMatch(/\.sidebar-titlebar-toggle\s*\{[^}]*position:\s*absolute[^}]*top:\s*0\.125rem[^}]*left:\s*5\.5rem[^}]*z-index:\s*1001[^}]*-webkit-app-region:\s*no-drag/s)
    expect(styles).toMatch(/\.window-no-drag[\s\S]*-webkit-app-region:\s*no-drag/)
    expect(toggleSource).toContain('className="size-[2.125rem] min-w-[2.125rem] rounded-md')
    expect(appSource).toContain('data-sidebar-toggle-top')
    expect(appSource).toContain('data-sidebar-toggle-bottom')
    expect(styles).not.toContain('.sidebar-collapse-toggle')
    expect(ipcSource).toContain("ipcMain.handle('window.toggleMaximize'")
    expect(ipcSource).toContain("ipcMain.handle('window.close'")
    expect(ipcSource).toContain("ipcMain.handle('window.minimize'")
    expect(ipcSource).toContain('BrowserWindow.fromWebContents(event.sender)')
    expect(ipcSource).toContain('toggleWindowMaximize(window)')
    expect(controlsSource).toContain("window.api.invoke('window.close')")
    expect(controlsSource).toContain("window.api.invoke('window.minimize')")
    expect(controlsSource).toContain("window.api.invoke('window.toggleMaximize')")
    expect(mainSource).toContain("if (process.platform === 'darwin') window.setWindowButtonVisibility(false)")
  })

  it('Chat Header 位于拖拽层之上，避免顶部按钮被拖拽热区拦截', () => {
    const chatSource = fs.readFileSync(
      path.join(appRoot, 'renderer/src/views/ChatView.tsx'),
      'utf8',
    )
    const styles = fs.readFileSync(
      path.join(appRoot, 'renderer/src/styles.css'),
      'utf8',
    )

    expect(styles).toMatch(/\.window-no-drag\s*\{[^}]*position:\s*relative[^}]*z-index:\s*1001/s)
    expect(chatSource).toContain('aria-label={t(\'closeHistory\')}')
    expect(chatSource).toContain('aria-label={t(\'openHistory\')}')
    expect(chatSource).toContain('aria-label={t(\'chatManagement\')}')
    expect(chatSource.match(/className="size-8 min-w-8 shrink-0 p-0"/g)).toHaveLength(1)
    expect(chatSource).toContain('className="window-no-drag flex min-w-0 items-center gap-1 border-b border-border px-3"')
    expect(chatSource).not.toContain('<SidebarToggle')
  })
})
