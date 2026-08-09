import { describe, expect, it, jest } from '@jest/globals'
import { closeWindow, minimizeWindow } from '../main/window-actions.js'

function createWindow() {
  return {
    close: jest.fn(),
    minimize: jest.fn(),
  }
}

describe('window actions', () => {
  it('关闭当前窗口', () => {
    const window = createWindow()

    expect(closeWindow(window)).toBe('closing')
    expect(window.close).toHaveBeenCalledTimes(1)
    expect(window.minimize).not.toHaveBeenCalled()
  })

  it('最小化当前窗口', () => {
    const window = createWindow()

    expect(minimizeWindow(window)).toBe('minimized')
    expect(window.minimize).toHaveBeenCalledTimes(1)
    expect(window.close).not.toHaveBeenCalled()
  })
})
