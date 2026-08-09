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

    expect(appSource).toContain('className="window-drag-region"')
    expect(appSource).toContain('className="window-titlebar-toggle-region"')
    expect(appSource).toContain("window.api.invoke('window.toggleMaximize')")
    expect(styles).toMatch(/\.window-drag-region\s*\{[^}]*-webkit-app-region:\s*drag/s)
    expect(styles).toMatch(/\.window-titlebar-toggle-region\s*\{[^}]*height:\s*0\.75rem[^}]*-webkit-app-region:\s*no-drag/s)
    expect(styles).toMatch(/\.window-no-drag[\s\S]*-webkit-app-region:\s*no-drag/)
    expect(styles).not.toContain('.sidebar-collapse-toggle')
    expect(ipcSource).toContain("ipcMain.handle('window.toggleMaximize'")
    expect(ipcSource).toContain('BrowserWindow.fromWebContents(event.sender)')
    expect(ipcSource).toContain('toggleWindowMaximize(window)')
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
    expect(chatSource).toContain('aria-label={historyPaneOpen ? t(\'closeHistory\') : t(\'openHistory\')}')
    expect(chatSource).toContain('aria-label={t(\'chatManagement\')}')
    expect(chatSource.match(/className="size-8 min-w-8 shrink-0 p-0"/g)).toHaveLength(1)
    expect(chatSource).toContain("className={`size-8 min-w-8 shrink-0 p-0 ${historyPaneOpen ? 'bg-surface-hover' : ''}`}")
  })
})
