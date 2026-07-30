import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export interface WindowPosition {
  x: number
  y: number
}

export interface WindowBounds extends WindowPosition {
  width: number
  height: number
}

export interface DisplayWorkArea extends WindowPosition {
  width: number
  height: number
}

function isWindowPosition(value: unknown): value is WindowPosition {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<WindowPosition>
  return Number.isSafeInteger(candidate.x) && Number.isSafeInteger(candidate.y)
}

function isWindowBounds(value: unknown): value is WindowBounds {
  if (!isWindowPosition(value)) return false
  const candidate = value as Partial<WindowBounds>
  return (
    Number.isSafeInteger(candidate.width) &&
    Number.isSafeInteger(candidate.height) &&
    (candidate.width ?? 0) > 0 &&
    (candidate.height ?? 0) > 0
  )
}

function isPersistedWindowState(
  value: unknown,
): value is WindowPosition | WindowBounds {
  if (!isWindowPosition(value)) return false
  const hasWidth = 'width' in value
  const hasHeight = 'height' in value
  return hasWidth === hasHeight && (!hasWidth || isWindowBounds(value))
}

function isVisibleOnDisplay(
  position: WindowPosition,
  workArea: DisplayWorkArea,
): boolean {
  return (
    position.x >= workArea.x &&
    position.x < workArea.x + workArea.width &&
    position.y >= workArea.y &&
    position.y < workArea.y + workArea.height
  )
}

export function loadWindowPosition(
  statePath: string,
  workAreas: DisplayWorkArea[],
): WindowPosition | WindowBounds | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(statePath, 'utf8'))
    if (!isPersistedWindowState(value)) return undefined
    return workAreas.some((workArea) => isVisibleOnDisplay(value, workArea))
      ? value
      : undefined
  } catch {
    return undefined
  }
}

export function saveWindowPosition(
  statePath: string,
  position: WindowBounds,
): void {
  if (!isWindowBounds(position)) {
    throw new TypeError('窗口位置和大小必须是有效的安全整数')
  }

  mkdirSync(path.dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(position)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporaryPath, statePath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}
