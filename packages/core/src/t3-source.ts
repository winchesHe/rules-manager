import Database from 'better-sqlite3'

interface T3Thread {
  id: string
  projectId: string
  title: string
  provider: string
  createdAt: string
  updatedAt: string
}

interface T3Binding {
  provider: string
  nativeId: string | null
}

interface T3Message {
  id: string
  role: string
  createdBy: string | null
  text: string | null
  createdAt: string
}

const threadsSql = `
  SELECT thread_id AS id, project_id AS projectId, title, default_provider AS provider,
         created_at AS createdAt, updated_at AS updatedAt
  FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
`

function withDatabase<T>(file: string, read: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

export function listT3Threads(file: string): T3Thread[] {
  return withDatabase(file, db =>
    db.prepare(threadsSql + ' ORDER BY updated_at DESC, thread_id').all() as T3Thread[])
}

export function readT3Thread(file: string, id: string) {
  return withDatabase(file, db => db.transaction(() => {
    const thread = db.prepare(threadsSql + ' AND thread_id = ?').get(id) as T3Thread | undefined
    if (!thread) return undefined

    const bindings = db.prepare(`
      SELECT DISTINCT provider, json_extract(payload_json, '$.nativeThreadRef.nativeId') AS nativeId
      FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?
      ORDER BY provider, nativeId
    `).all(id) as T3Binding[]
    const messages = db.prepare(`
      SELECT message_id AS id, role, json_extract(payload_json, '$.createdBy') AS createdBy,
             json_extract(payload_json, '$.text') AS text, created_at AS createdAt
      FROM orchestration_v2_projection_messages WHERE thread_id = ?
      ORDER BY created_at, message_id
    `).all(id) as T3Message[]
    return { thread, bindings, messages }
  })())
}
