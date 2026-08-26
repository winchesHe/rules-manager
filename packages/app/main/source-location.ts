import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { resolveWorkspace } from '@memory-manager/core/workspace'

export function resolveProjectLocation(slug: string, homeDir?: string): string {
  if (!slug.trim()) throw new Error('project slug is required')
  const { projectsDir } = resolveWorkspace(homeDir)
  const projectPath = path.resolve(projectsDir, slug)
  if (path.dirname(projectPath) !== path.resolve(projectsDir)) {
    throw new Error('project slug is invalid')
  }
  if (!fs.statSync(projectPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`project location is unavailable: ${slug}`)
  }
  return projectPath
}

export function resolveSessionLocation(sessionId: string, homeDir?: string): string {
  if (!sessionId.trim()) throw new Error('session id is required')
  const { dbPath } = resolveWorkspace(homeDir)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  let sourcePath: string | undefined
  try {
    sourcePath = (db.prepare('SELECT source_path FROM sessions WHERE id = ?').get(sessionId) as {
      source_path: string
    } | undefined)?.source_path
  } finally {
    db.close()
  }
  if (!sourcePath) throw new Error(`session was not found: ${sessionId}`)
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`session source is unavailable: ${sessionId}`)
  }
  return sourcePath
}
