import fs from 'node:fs'
import Database from 'better-sqlite3'
import { readJsonlObjects } from '../adapters/shared.js'
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

function readCodexRecords(sourcePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(sourcePath)) throw new Error(`Codex session 源文件不存在：${sourcePath}`)
  if (fs.statSync(sourcePath).size > 50 * 1024 * 1024) {
    throw new Error(`Codex session 超过 50 MiB，暂不支持一次性输出：${sourcePath}`)
  }
  const records = readJsonlObjects(sourcePath)
  if (records.length === 0) throw new Error(`Codex session 没有可解析内容：${sourcePath}`)
  return records
}

export async function runSessionsShow(
  sessionId: string,
  opts: SessionsShowOptions = {},
  deps: SessionsShowDeps = {},
): Promise<void> {
  const session = loadStoredSession(sessionId, opts.homeDir)
  if (session.agent === 'codex') {
    const records = readCodexRecords(session.source_path)
    console.log(JSON.stringify({ sessionId, agent: session.agent, records }, null, 2))
    return
  }
  if (session.agent !== 'opencode') {
    throw new Error(`sessions show 当前仅支持 OpenCode/Codex，实际 agent：${session.agent}`)
  }

  const directory = loadOpenCodeDirectory(session.source_path, sessionId)
  const messages = await (deps.readOpenCodeMessages ?? readOpenCodeMessages)({
    sessionId,
    directory,
  })
  console.log(JSON.stringify({ sessionId, agent: session.agent, directory, messages }, null, 2))
}
