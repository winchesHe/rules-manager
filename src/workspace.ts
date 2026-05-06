import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const WORKSPACE_DIR = path.join(os.homedir(), '.memory-manager')
export const DB_PATH = path.join(WORKSPACE_DIR, 'memory.db')
export const RULES_DIR = path.join(WORKSPACE_DIR, 'rules')
export const PROJECTS_DIR = path.join(RULES_DIR, 'projects')

export function resolveWorkspace(homeDir?: string): {
  workspaceDir: string
  dbPath: string
  rulesDir: string
  projectsDir: string
} {
  const base = homeDir ? path.join(homeDir, '.memory-manager') : WORKSPACE_DIR
  return {
    workspaceDir: base,
    dbPath: path.join(base, 'memory.db'),
    rulesDir: path.join(base, 'rules'),
    projectsDir: path.join(base, 'rules', 'projects'),
  }
}

export function workspaceExists(homeDir?: string): boolean {
  const { workspaceDir } = resolveWorkspace(homeDir)
  return fs.existsSync(workspaceDir)
}
