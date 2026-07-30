import fs from 'node:fs'
import Database from 'better-sqlite3'
import { resolveWorkspace } from './workspace.js'

const SCHEMA_VERSION = 6

/**
 * Schema v6：FS-first session 索引 + rule candidate 生成审计。
 *
 * 表清单：
 *   - schema_meta：版本
 *   - sessions：session 状态机（slug / status / classified_at / rules_status）
 *   - run_metadata：scan/reclassify/generate-rules 运行日志
 *   - rule_candidates：待人工 review 的结构化规则候选与 evidence
 *   - llm_runs：不含 prompt/response 原文的 LLM 调用 hash 审计
 *
 * 项目分类视图全部走 FS：<workspace>/projects/<slug>/<sid>.jsonl symlink。
 * 详见 docs/specs/scan-classify-fs-rewrite.md。
 */
function applySchema(db: Database.Database): void {
  // 永久存在
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  const existing = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get() as { value: string } | undefined

  const currentVersion = existing ? Number(existing.value) : 0

  // v1-v4 → v5：直接 drop 所有内容表 + 旧 sessions（spec 已声明本地用户手动 rm 重扫，不迁数据）
  if (currentVersion > 0 && currentVersion < 5) {
    migrateToV5(db)
  }

  // v5 表（fresh init 或 migrate 后都走这里）
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                   TEXT PRIMARY KEY,
      agent                TEXT NOT NULL,
      source_path          TEXT NOT NULL,
      workspace_link       TEXT NOT NULL,
      slug                 TEXT NOT NULL DEFAULT 'default',
      content_hash         TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'new',
      first_seen_at        TEXT NOT NULL,
      last_seen_at         TEXT NOT NULL,
      classified_at        TEXT,
      rules_status         TEXT,
      rules_generated_at   TEXT
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

  migrateV5ToV6(db)
  addColumnIfMissing(
    db,
    'ALTER TABLE rule_candidates ADD COLUMN run_id TEXT',
  )

  if (!existing) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(
      String(SCHEMA_VERSION),
    )
  } else if (currentVersion < SCHEMA_VERSION) {
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(
      String(SCHEMA_VERSION),
    )
  }
}

function addColumnIfMissing(
  db: Database.Database,
  statement: string,
): void {
  try {
    db.exec(statement)
  } catch (error) {
    const message = error
      && typeof error === 'object'
      && 'message' in error
      && typeof error.message === 'string'
        ? error.message
        : ''
    if (message.toLowerCase().includes('duplicate column name')) {
      return
    }
    throw error
  }
}

function migrateV5ToV6(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_candidates (
      id               TEXT PRIMARY KEY,
      scope            TEXT NOT NULL,
      project_slug     TEXT,
      rule_text        TEXT NOT NULL,
      confidence_level TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'draft',
      evidence_json    TEXT NOT NULL,
      source_sessions  TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_runs (
      id               TEXT PRIMARY KEY,
      task             TEXT NOT NULL,
      model            TEXT NOT NULL,
      input_hash       TEXT NOT NULL,
      output_hash      TEXT NOT NULL,
      status           TEXT NOT NULL,
      token_usage_json TEXT,
      created_at       TEXT NOT NULL
    );
  `)
}

function migrateToV5(db: Database.Database): void {
  // 旧版本（v1-v4）→ v5：清空所有数据表，让外层 CREATE IF NOT EXISTS 建新 schema。
  // 用户主 home 数据由用户自己决定何时清；这里只是 schema 升级路径上的兜底。
  db.exec(`
    DROP TABLE IF EXISTS rule_candidates;
    DROP TABLE IF EXISTS project_hints;
    DROP TABLE IF EXISTS session_projects;
    DROP TABLE IF EXISTS projects;
    DROP TABLE IF EXISTS sessions;
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
