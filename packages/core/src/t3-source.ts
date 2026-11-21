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

interface T3Tool {
  id: string
  name: string
  input: unknown
  output?: unknown
  startedAt?: string
  completedAt?: string
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
    const tools: T3Tool[] = []
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='orchestration_v2_projection_turn_items'").get()) {
      const rows = db.prepare(`
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ? AND type IN ('dynamic_tool', 'command_execution')
        ORDER BY ordinal, turn_item_id
      `).iterate(id) as Iterable<{ payload_json: string }>
      for (const row of rows) {
        const item = JSON.parse(row.payload_json)
        tools.push({ id: item.id, name: item.toolName ?? item.type, input: item.input,
          output: item.output, startedAt: item.startedAt, completedAt: item.completedAt })
      }
    }
    return { thread, bindings, messages, tools }
  })())
}

export function listT3Bindings(file: string) {
  return withDatabase(file, db => db.prepare(`
    SELECT DISTINCT thread_id AS threadId, provider,
           json_extract(payload_json, '$.nativeThreadRef.nativeId') AS nativeId
    FROM orchestration_v2_projection_provider_threads
    WHERE provider IN ('antigravity', 'grok')
  `).all() as Array<T3Binding & { threadId: string }>)
}

export function t3Projects(file: string) {
  return withDatabase(file, db => new Map((db.prepare(
    'SELECT project_id, workspace_root FROM projection_projects',
  ).all() as Array<{ project_id: string; workspace_root: string }>).map(row =>
    [row.project_id, row.workspace_root])))
}

export function t3ContentWatermarks(file: string) {
  return withDatabase(file, db => {
    // 消息编辑或工具完成时，线程自身的更新时间可能保持不变。
    const rows = db.prepare(`
      SELECT thread_id AS id, count(*) AS count, max(updated_at) AS updated FROM
        orchestration_v2_projection_messages GROUP BY thread_id
    `).all() as Array<{ id: string; count: number; updated: string }>
    const marks = new Map<string, Array<[number, string]>>()
    for (const row of rows) marks.set(row.id, [[row.count, row.updated]])
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='orchestration_v2_projection_turn_items'").get()) {
      const items = db.prepare(`
        SELECT thread_id AS id, count(*) AS count, max(updated_at) AS updated
        FROM orchestration_v2_projection_turn_items
        WHERE type IN ('dynamic_tool','command_execution') GROUP BY thread_id
      `).all() as typeof rows
      for (const row of items) marks.set(row.id, [...(marks.get(row.id) ?? []), [row.count, row.updated]])
    }
    return marks
  })
}

export function t3Title(file: string, id: string) {
  return withDatabase(file, db => (db.prepare(threadsSql + ' AND thread_id = ?').get(id) as T3Thread | undefined)?.title)
}
