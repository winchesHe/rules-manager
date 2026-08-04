import { describe, expect, it, jest } from '@jest/globals'
import { toggleWindowMaximize } from '../main/window-maximize.js'

function createWindow(state: { fullscreen?: boolean; maximized?: boolean } = {}) {
  return {
    isFullScreen: jest.fn(() => state.fullscreen ?? false),
    isMaximized: jest.fn(() => state.maximized ?? false),
    maximize: jest.fn(),
    unmaximize: jest.fn(),
  }
}

describe('toggleWindowMaximize', () => {
  it('普通窗口切换为最大化', () => {
    const window = createWindow()

    expect(toggleWindowMaximize(window)).toBe('maximized')
    expect(window.maximize).toHaveBeenCalledTimes(1)
    expect(window.unmaximize).not.toHaveBeenCalled()
  })

  it('已最大化窗口恢复原大小', () => {
    const window = createWindow({ maximized: true })

    expect(toggleWindowMaximize(window)).toBe('restored')
    expect(window.unmaximize).toHaveBeenCalledTimes(1)
    expect(window.maximize).not.toHaveBeenCalled()
  })

  it('全屏状态不改变窗口', () => {
    const window = createWindow({ fullscreen: true, maximized: true })

    expect(toggleWindowMaximize(window)).toBe('fullscreen')
    expect(window.isMaximized).not.toHaveBeenCalled()
    expect(window.maximize).not.toHaveBeenCalled()
    expect(window.unmaximize).not.toHaveBeenCalled()
  })
})
