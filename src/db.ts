import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { resolveWorkspace } from './workspace.js'

const SCHEMA_VERSION = 4

/**
 * 初始化 DB schema：只存内部状态，不存完整 content。
 * 允许字段：session id / agent / source path / updated_at / content_hash /
 *           project_key / project hints / rule candidates / confidence /
 *           user feedback / evidence pointer / run metadata
 *
 * v3: sessions 表加 ParsedSession 列（messageCount / toolCallCount / 时间戳 / metadata JSON），
 *      run_metadata 表加 details 列（JSON：摘要 + 错误条目）。
 */
function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      agent           TEXT NOT NULL,
      source_path     TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      project_key     TEXT,
      source_kind     TEXT NOT NULL DEFAULT '',
      scan_state      TEXT NOT NULL DEFAULT 'new',
      first_seen_at   TEXT NOT NULL DEFAULT '',
      last_seen_at    TEXT NOT NULL DEFAULT '',
      message_count   INTEGER NOT NULL DEFAULT 0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      first_timestamp TEXT,
      last_timestamp  TEXT,
      parsed_metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      project_key  TEXT PRIMARY KEY,
      hints        TEXT,
      updated_at   TEXT NOT NULL,
      confidence   REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_projects (
      session_id   TEXT PRIMARY KEY,
      project_key  TEXT NOT NULL,
      confidence   REAL NOT NULL DEFAULT 0,
      decided_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_hints (
      session_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,
      value        TEXT NOT NULL,
      project_key  TEXT NOT NULL,
      confidence   REAL NOT NULL,
      agent        TEXT NOT NULL,
      source       TEXT NOT NULL,
      locator      TEXT,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (session_id, kind, value)
    );

    CREATE TABLE IF NOT EXISTS rule_candidates (
      id             TEXT PRIMARY KEY,
      project_key    TEXT,
      content_hash   TEXT NOT NULL,
      confidence     REAL NOT NULL DEFAULT 0,
      user_feedback  TEXT,
      evidence_ptr   TEXT,
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_metadata (
      id         TEXT PRIMARY KEY,
      run_type   TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at   TEXT,
      status     TEXT NOT NULL DEFAULT 'running',
      details    TEXT
    );
  `)

  const existing = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get() as { value: string } | undefined

  if (!existing) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(
      String(SCHEMA_VERSION),
    )
    return
  }

  const currentVersion = Number(existing.value)
  if (currentVersion < 2) migrateV1ToV2(db)
  if (currentVersion < 3) migrateV2ToV3(db)
  if (currentVersion < 4) migrateV3ToV4(db)
  if (currentVersion < SCHEMA_VERSION) {
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(
      String(SCHEMA_VERSION),
    )
  }
}

function addColumnIfMissing(db: Database.Database, table: string, columnDef: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`)
  } catch (err) {
    // sqlite 唯一可接受的错误：duplicate column。其他错误抛出，避免半迁移。
    const msg = err instanceof Error ? err.message : String(err)
    if (!/duplicate column name/i.test(msg)) throw err
  }
}

function migrateV1ToV2(db: Database.Database): void {
  for (const col of [
    "source_kind   TEXT NOT NULL DEFAULT ''",
    "scan_state    TEXT NOT NULL DEFAULT 'new'",
    "first_seen_at TEXT NOT NULL DEFAULT ''",
    "last_seen_at  TEXT NOT NULL DEFAULT ''",
  ]) {
    addColumnIfMissing(db, 'sessions', col)
  }
}

function migrateV2ToV3(db: Database.Database): void {
  for (const col of [
    'message_count   INTEGER NOT NULL DEFAULT 0',
    'tool_call_count INTEGER NOT NULL DEFAULT 0',
    'first_timestamp TEXT',
    'last_timestamp  TEXT',
    'parsed_metadata TEXT',
  ]) {
    addColumnIfMissing(db, 'sessions', col)
  }
  addColumnIfMissing(db, 'run_metadata', 'details TEXT')
}

function migrateV3ToV4(db: Database.Database): void {
  addColumnIfMissing(db, 'projects', 'confidence REAL NOT NULL DEFAULT 0')
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_projects (
      session_id   TEXT PRIMARY KEY,
      project_key  TEXT NOT NULL,
      confidence   REAL NOT NULL DEFAULT 0,
      decided_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_hints (
      session_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,
      value        TEXT NOT NULL,
      project_key  TEXT NOT NULL,
      confidence   REAL NOT NULL,
      agent        TEXT NOT NULL,
      source       TEXT NOT NULL,
      locator      TEXT,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (session_id, kind, value)
    );
  `)
}

export function initDatabase(homeDir?: string): Database.Database {
  const { dbPath } = resolveWorkspace(homeDir)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  applySchema(db)
  return db
}

export function isDatabaseReady(homeDir?: string): boolean {
  const { dbPath } = resolveWorkspace(homeDir)
  if (!fs.existsSync(dbPath)) return false
  let db: Database.Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: string } | undefined
    return row !== undefined
  } catch {
    return false
  } finally {
    db?.close()
  }
}

export function getDbPath(homeDir?: string): string {
  return resolveWorkspace(homeDir).dbPath
}
