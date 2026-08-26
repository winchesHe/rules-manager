import { contextBridge, ipcRenderer } from 'electron'

type EventCallback = (...args: unknown[]) => void

const listeners = new WeakMap<EventCallback, Map<string, (...args: unknown[]) => void>>()

function offEvent(channel: string, callback: EventCallback): void {
  const callbackListeners = listeners.get(callback)
  const listener = callbackListeners?.get(channel)
  if (!callbackListeners || !listener) return

  ipcRenderer.off(channel, listener)
  callbackListeners.delete(channel)
  if (callbackListeners.size === 0) listeners.delete(callback)
}

function onEvent(channel: string, callback: EventCallback): void {
  offEvent(channel, callback)

  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
  const callbackListeners = listeners.get(callback) ?? new Map()
  callbackListeners.set(channel, listener)
  listeners.set(callback, callbackListeners)
  ipcRenderer.on(channel, listener)
}

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  onEvent,
  offEvent,
})
