import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { collectFilesRecursive } from '../adapters/shared.js'
import { resolveWorkspace } from '../workspace.js'

interface SessionsShowOptions {
  homeDir?: string
}

interface OpenCodeReadInput {
  sessionId: string
  directory: string
}

interface SessionsShowDeps {
  readOpenCodeMessages?: (input: OpenCodeReadInput) => Promise<unknown>
}

interface StoredSessionRow {
  agent: string
  source_path: string
}

const MAX_SHOW_BYTES = 50 * 1024 * 1024
const JSONL_AGENTS = new Set(['claude', 'codex', 'cursor', 'pi'])

async function readOpenCodeMessages(input: OpenCodeReadInput): Promise<unknown> {
  const { createOpencode } = await import('@opencode-ai/sdk/v2')
  const { client, server } = await createOpencode({
    hostname: '127.0.0.1',
    port: 0,
    timeout: 30_000,
  })

  try {
    const response = await client.session.messages({
      sessionID: input.sessionId,
      directory: input.directory,
    })
    if (response.error) {
      throw new Error(`OpenCode 读取失败：${JSON.stringify(response.error)}`)
    }
    return response.data ?? []
  } finally {
    server.close()
  }
}

function loadStoredSession(sessionId: string, homeDir?: string): StoredSessionRow {
  const { dbPath } = resolveWorkspace(homeDir)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db
      .prepare('SELECT agent, source_path FROM sessions WHERE id = ?')
      .get(sessionId) as StoredSessionRow | undefined
    if (!row) throw new Error(`session 不存在：${sessionId}`)
    return row
  } finally {
    db.close()
  }
}

function loadOpenCodeDirectory(sourcePath: string, sessionId: string): string {
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
    const row = db
      .prepare('SELECT directory FROM session WHERE id = ?')
      .get(sessionId) as { directory: string } | undefined
    if (!row) throw new Error(`OpenCode session 不存在：${sessionId}`)
    return row.directory
  } finally {
    db.close()
  }
}

function jsonlFiles(sourcePath: string, agent: string): string[] {
  if (!fs.existsSync(sourcePath)) throw new Error(`${agent} session 源不存在：${sourcePath}`)
  const stat = fs.statSync(sourcePath)
  const files = stat.isDirectory()
    ? collectFilesRecursive(sourcePath, (filePath) => filePath.endsWith('.jsonl'))
    : [sourcePath]
  if (files.length === 0) throw new Error(`${agent} session 没有 JSONL 文件：${sourcePath}`)
  const totalBytes = files.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0)
  if (totalBytes > MAX_SHOW_BYTES) {
    throw new Error(`${agent} session 超过 50 MiB，暂不支持一次性输出：${sourcePath}`)
  }
  return files
}

function readJsonlRecords(sourcePath: string, agent: string): unknown[] {
  const records: unknown[] = []
  for (const filePath of jsonlFiles(sourcePath, agent)) {
    const lines = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        throw new Error(`${agent} JSONL 解析失败：${filePath}:${index + 1}`)
      }
    }
  }
  if (records.length === 0) throw new Error(`${agent} session 没有可解析内容：${sourcePath}`)
  return records
}

function copilotStorePath(sourcePath: string): string | undefined {
  let directory = path.dirname(sourcePath)
  while (directory !== path.dirname(directory)) {
    if (path.basename(directory) === 'session-state') {
      const candidate = path.join(path.dirname(directory), 'session-store.db')
      return fs.existsSync(candidate) ? candidate : undefined
    }
    directory = path.dirname(directory)
  }
  return undefined
}

function readCopilotSession(sessionId: string, sourcePath: string): Record<string, unknown> {
  const eventsPath = path.basename(sourcePath) === 'events.jsonl'
    ? sourcePath
    : path.join(path.dirname(sourcePath), 'events.jsonl')
  if (fs.existsSync(eventsPath)) {
    return { source: 'events.jsonl', records: readJsonlRecords(eventsPath, 'copilot') }
  }

  const storePath = copilotStorePath(sourcePath)
  if (!storePath) {
    throw new Error(`Copilot session 只有 metadata，源端未持久化对话：${sessionId}`)
  }
  const db = new Database(storePath, { readonly: true, fileMustExist: true })
  try {
    const turns = db
      .prepare(`
        SELECT turn_index, user_message, assistant_response, timestamp
        FROM turns
        WHERE session_id = ?
        ORDER BY turn_index
      `)
      .all(sessionId)
    if (turns.length === 0) {
      throw new Error(`Copilot session 只有 metadata，源端未持久化对话：${sessionId}`)
    }
    return { source: 'session-store.db', turns }
  } finally {
    db.close()
  }
}

export async function runSessionsShow(
  sessionId: string,
  opts: SessionsShowOptions = {},
  deps: SessionsShowDeps = {},
): Promise<void> {
  const session = loadStoredSession(sessionId, opts.homeDir)
  if (JSONL_AGENTS.has(session.agent)) {
    const records = readJsonlRecords(session.source_path, session.agent)
    console.log(JSON.stringify({ sessionId, agent: session.agent, records }, null, 2))
    return
  }
  if (session.agent === 'copilot') {
    const content = readCopilotSession(sessionId, session.source_path)
    console.log(JSON.stringify({ sessionId, agent: session.agent, ...content }, null, 2))
    return
  }
  if (session.agent !== 'opencode') {
    throw new Error(`sessions show 不支持的 agent：${session.agent}`)
  }

  const directory = loadOpenCodeDirectory(session.source_path, sessionId)
  const messages = await (deps.readOpenCodeMessages ?? readOpenCodeMessages)({
    sessionId,
    directory,
  })
  console.log(JSON.stringify({ sessionId, agent: session.agent, directory, messages }, null, 2))
}
