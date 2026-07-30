import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@jest/globals'
import {
  loadWindowPosition,
  saveWindowPosition,
} from '../main/window-position.js'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function createStatePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'memory-manager-window-position-'))
  return path.join(directory, 'window-position.json')
}

const displays = [
  { x: 0, y: 0, width: 1440, height: 900 },
  { x: -1920, y: 0, width: 1920, height: 1080 },
]

describe('window position', () => {
  it('保存并恢复当前显示器范围内的位置与大小', () => {
    const statePath = createStatePath()

    saveWindowPosition(statePath, {
      x: -1280,
      y: 120,
      width: 1180,
      height: 760,
    })

    expect(loadWindowPosition(statePath, displays)).toEqual({
      x: -1280,
      y: 120,
      width: 1180,
      height: 760,
    })
  })

  it('兼容旧版仅含位置的状态文件', () => {
    const statePath = createStatePath()
    writeFileSync(statePath, JSON.stringify({ x: 400, y: 180 }), 'utf8')

    expect(loadWindowPosition(statePath, displays)).toEqual({ x: 400, y: 180 })
  })

  it('显示器布局变化导致坐标不可见时回退默认位置', () => {
    const statePath = createStatePath()
    saveWindowPosition(statePath, {
      x: -1280,
      y: 120,
      width: 1180,
      height: 760,
    })

    expect(loadWindowPosition(statePath, [displays[0]])).toBeUndefined()
  })

  it.each([
    ['损坏 JSON', '{'],
    ['非数字字段', JSON.stringify({ x: '100', y: 200 })],
    ['非整数坐标', JSON.stringify({ x: 100.5, y: 200 })],
    ['尺寸字段不完整', JSON.stringify({ x: 100, y: 200, width: 1200 })],
    ['尺寸不是正整数', JSON.stringify({ x: 100, y: 200, width: 0, height: 700 })],
  ])('%s 不阻塞应用启动', (_label, content) => {
    const statePath = createStatePath()
    writeFileSync(statePath, content, 'utf8')

    expect(loadWindowPosition(statePath, displays)).toBeUndefined()
  })

  it('主窗口恢复 bounds，并在移动、缩放与关闭时保存普通窗口状态', () => {
    const mainSource = readFileSync(path.join(appRoot, 'main/index.ts'), 'utf8')

    expect(mainSource).toContain('...restoredPosition')
    expect(mainSource).toContain('window.getBounds()')
    expect(mainSource).toContain("window.on('move', persistWindowState)")
    expect(mainSource).toContain("window.on('resize', persistWindowState)")
    expect(mainSource).toContain("window.once('close', persistWindowState)")
    expect(mainSource).toMatch(
      /window\.isMinimized\(\)[\s\S]*window\.isMaximized\(\)[\s\S]*window\.isFullScreen\(\)/,
    )
  })
})
