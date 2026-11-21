import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

interface Summary { id: string; title: string; uris: string; modified: string }

export function antigravitySummaries(root: string): Map<string, Summary> {
  const file = path.join(root, 'conversation_summaries.db')
  if (!fs.existsSync(file)) return new Map()
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare(`SELECT conversation_id AS id, title, workspace_uris AS uris,
      last_modified_time AS modified FROM conversation_summaries`).all() as Summary[]
    return new Map(rows.map(r => [r.id, r]))
  } finally { db.close() }
}

export function antigravityRoot(file: string) {
  return path.basename(path.dirname(file)) === 'conversations'
    ? path.resolve(file, '../..') : path.resolve(file, '../../../../..')
}

export function antigravityTitle(file: string, id: string) {
  return antigravitySummaries(antigravityRoot(file)).get(id)?.title
}
