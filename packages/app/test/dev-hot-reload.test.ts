import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@jest/globals'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

describe('APP dev hot reload', () => {
  it('dev script 显式监听 Main 与 Preload 源码', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
    expect(packageJson.scripts?.dev).toBe('electron-vite dev --watch')
  })

  it('Renderer 固定 dev 端口并拒绝静默漂移', () => {
    const config = read('electron.vite.config.ts')
    expect(config).toContain('port: 5173')
    expect(config).toContain('strictPort: true')
  })
})
