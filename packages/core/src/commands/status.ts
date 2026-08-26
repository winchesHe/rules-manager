import fs from 'node:fs'
import pc from 'picocolors'
import { resolveWorkspace } from '../workspace.js'
import { isDatabaseReady } from '../db.js'

export interface StatusOptions {
  homeDir?: string
}

export function runStatus(opts: StatusOptions = {}): void {
  const { workspaceDir, projectsDir } = resolveWorkspace(opts.homeDir)

  const home = process.env.HOME
  const homePath =
    home && workspaceDir.startsWith(home + '/')
      ? '~' + workspaceDir.slice(home.length)
      : workspaceDir
  const dbReady = isDatabaseReady(opts.homeDir)
  const rulesDirReady = fs.existsSync(projectsDir)

  console.log(`Home: ${homePath}`)
  console.log(`Database: ${dbReady ? 'ready' : 'not initialized'}`)
  console.log(`Rules dir: ${rulesDirReady ? 'ready' : 'not initialized'}`)
  console.log('Configured agents: auto-detect')
}
