import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { resolveWorkspace } from './workspace.js'

const SCHEMA_VERSION = 2

/**
 * 初始化 DB schema：只存内部状态，不存完整 content。
 * 允许字段：session id / agent / source path / updated_at / content_hash /
 *           project_key / project hints / rule candidates / confidence /
 *           user feedback / evidence pointer / run metadata
 */
function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      agent         TEXT NOT NULL,
      source_path   TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      project_key   TEXT,
      source_kind   TEXT NOT NULL DEFAULT '',
      scan_state    TEXT NOT NULL DEFAULT 'new',
      first_seen_at TEXT NOT NULL DEFAULT '',
      last_seen_at  TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS projects (
      project_key  TEXT PRIMARY KEY,
      hints        TEXT,
      updated_at   TEXT NOT NULL
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
      status     TEXT NOT NULL DEFAULT 'running'
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
  if (currentVersion < 2) {
    migrateV1ToV2(db)
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(
      String(SCHEMA_VERSION),
    )
  }
}

function migrateV1ToV2(db: Database.Database): void {
  const newColumns = [
    "source_kind   TEXT NOT NULL DEFAULT ''",
    "scan_state    TEXT NOT NULL DEFAULT 'new'",
    "first_seen_at TEXT NOT NULL DEFAULT ''",
    "last_seen_at  TEXT NOT NULL DEFAULT ''",
  ]
  for (const col of newColumns) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`)
    } catch {
      // column already exists
    }
  }
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
