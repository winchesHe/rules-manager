import { join } from 'node:path'
import { app, BrowserWindow, screen, shell } from 'electron'
import { registerIpcHandlers, shutdownNativeChatRuntimes } from './ipc'
import {
  loadWindowPosition,
  saveWindowPosition,
} from './window-position'
import { cleanupStaleEvidenceContexts } from '../../core/src/evidence-context'
import { cleanupStaleLiveEvidenceContexts } from '../../core/src/live-evidence-context'
import { clearChatCompletionBadge } from './app-badge'

let mainWindow: BrowserWindow | null = null
let nativeRuntimesShuttingDown = false
let nativeRuntimesShutdown = false

app.setName('Agent Dashboard')

function createWindow(): void {
  const positionStatePath = join(app.getPath('userData'), 'window-position.json')
  const restoredPosition = loadWindowPosition(
    positionStatePath,
    screen.getAllDisplays().map((display) => display.workArea),
  )
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#f4f5f7',
    title: 'Agent Dashboard',
    titleBarStyle: 'hiddenInset',
    ...restoredPosition,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
    },
  })
  mainWindow = window

  const persistWindowState = (): void => {
    if (window.isMinimized() || window.isMaximized() || window.isFullScreen()) return
    try {
      saveWindowPosition(positionStatePath, window.getBounds())
    } catch (error) {
      console.warn('[app] failed to save window state', error)
    }
  }

  window.on('move', persistWindowState)
  window.on('resize', persistWindowState)
  window.on('focus', clearChatCompletionBadge)
  window.once('close', persistWindowState)
  window.once('ready-to-show', () => window.show())
  window.once('closed', () => {
    mainWindow = null
  })
  window.webContents.once('did-finish-load', () => {
    console.log('[app] renderer-ready')
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.show()
    mainWindow?.focus()
  })

  app.whenReady().then(() => {
    cleanupStaleEvidenceContexts()
    cleanupStaleLiveEvidenceContexts()
    registerIpcHandlers()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    if (nativeRuntimesShutdown) return
    event.preventDefault()
    if (nativeRuntimesShuttingDown) return
    nativeRuntimesShuttingDown = true
    void shutdownNativeChatRuntimes().finally(() => {
      nativeRuntimesShutdown = true
      app.quit()
    })
  })
}
