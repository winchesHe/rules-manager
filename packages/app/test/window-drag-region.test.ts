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

    expect(appSource).toContain('className="window-drag-region"')
    expect(styles).toMatch(/\.window-drag-region\s*\{[^}]*-webkit-app-region:\s*drag/s)
    expect(styles).toMatch(/\.window-no-drag[\s\S]*-webkit-app-region:\s*no-drag/)
  })
})
