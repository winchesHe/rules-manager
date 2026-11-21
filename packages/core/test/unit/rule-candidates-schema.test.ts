import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { loadLlmConfig } from '../../src/config'
import { initDatabase } from '../../src/db'
import { resolveWorkspace } from '../../src/workspace'

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-rules-schema-'))
  fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
  return home
}

describe('schema v6 与 LLM config', () => {
  let home: string

  beforeEach(() => {
    home = makeTempHome()
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('fresh init 创建 v6 的 rule_candidates 和 llm_runs', () => {
    const db = initDatabase(home)
    const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string }
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)
    db.close()

    expect(version.value).toBe('7')
    expect(tables).toEqual(['llm_runs', 'rule_candidates', 'run_metadata', 'schema_meta', 'session_bindings', 'sessions'])
  })

  it('v5 数据库原地迁移且保留 sessions 数据', () => {
    const dbPath = resolveWorkspace(home).dbPath
    const oldDb = new Database(dbPath)
    oldDb.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES ('version', '5');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, source_path TEXT NOT NULL,
        workspace_link TEXT NOT NULL, slug TEXT NOT NULL DEFAULT 'default',
        content_hash TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, classified_at TEXT,
        rules_status TEXT, rules_generated_at TEXT
      );
      CREATE TABLE run_metadata (
        id TEXT PRIMARY KEY, run_type TEXT NOT NULL, started_at TEXT NOT NULL,
        ended_at TEXT, status TEXT NOT NULL DEFAULT 'running', details TEXT
      );
      INSERT INTO sessions VALUES (
        's1', 'claude', '/source', '/link', 'demo', 'hash', '2026-07-27',
        'unchanged', '2026-07-27', '2026-07-27', NULL, NULL, NULL
      );
    `)
    oldDb.close()

    const db = initDatabase(home)
    expect(db.prepare('SELECT slug FROM sessions WHERE id = ?').get('s1')).toEqual({ slug: 'demo' })
    expect((db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string }).value).toBe('7')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'rule_candidates'").get()).toBeTruthy()
    db.close()
  })

  it('新表字段与默认状态符合契约', () => {
    const db = initDatabase(home)
    const candidateColumns = db.pragma('table_info(rule_candidates)') as Array<{ name: string; dflt_value: string | null }>
    const runColumns = (db.pragma('table_info(llm_runs)') as Array<{ name: string }>).map((column) => column.name)
    db.close()

    expect(candidateColumns.map((column) => column.name)).toEqual([
      'id', 'scope', 'project_slug', 'rule_text', 'confidence_level', 'status',
      'evidence_json', 'source_sessions', 'created_at', 'updated_at', 'run_id',
    ])
    expect(candidateColumns.find((column) => column.name === 'status')?.dflt_value).toBe("'draft'")
    expect(runColumns).toEqual([
      'id', 'task', 'model', 'input_hash', 'output_hash', 'status', 'token_usage_json', 'created_at',
    ])
  })

  it('现有 v6 数据库通过受保护加列补齐 candidate run_id', () => {
    const dbPath = resolveWorkspace(home).dbPath
    const oldDb = new Database(dbPath)
    oldDb.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES ('version', '6');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, source_path TEXT NOT NULL,
        workspace_link TEXT NOT NULL, slug TEXT NOT NULL DEFAULT 'default',
        content_hash TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, classified_at TEXT,
        rules_status TEXT, rules_generated_at TEXT
      );
      CREATE TABLE run_metadata (
        id TEXT PRIMARY KEY, run_type TEXT NOT NULL, started_at TEXT NOT NULL,
        ended_at TEXT, status TEXT NOT NULL DEFAULT 'running', details TEXT
      );
      CREATE TABLE rule_candidates (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, project_slug TEXT,
        rule_text TEXT NOT NULL, confidence_level TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', evidence_json TEXT NOT NULL,
        source_sessions TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE llm_runs (
        id TEXT PRIMARY KEY, task TEXT NOT NULL, model TEXT NOT NULL,
        input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, status TEXT NOT NULL,
        token_usage_json TEXT, created_at TEXT NOT NULL
      );
    `)
    oldDb.close()

    const db = initDatabase(home)
    const columns = (db.pragma('table_info(rule_candidates)') as Array<{ name: string }>)
      .map((column) => column.name)
    db.close()

    expect(columns).toContain('run_id')
  })

  it('config 缺失时返回可运行默认值', () => {
    expect(loadLlmConfig(home)).toEqual({ provider: 'claude', effort: 'medium' })
  })

  it('config.json 覆盖默认 provider/model/effort', () => {
    fs.writeFileSync(
      path.join(resolveWorkspace(home).workspaceDir, 'config.json'),
      JSON.stringify({ provider: 'codex', model: 'gpt-test', effort: 'high' }),
    )

    expect(loadLlmConfig(home)).toEqual({ provider: 'codex', model: 'gpt-test', effort: 'high' })
  })

  it('config.json 支持完整 effort 档位与 Fast Mode', () => {
    fs.writeFileSync(
      path.join(resolveWorkspace(home).workspaceDir, 'config.json'),
      JSON.stringify({ provider: 'claude', effort: 'max', fastMode: true }),
    )

    expect(loadLlmConfig(home)).toEqual({
      provider: 'claude',
      effort: 'max',
      fastMode: true,
    })
  })
})
