import { readSessionEventSources } from '../session-events.js'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import Database from 'better-sqlite3'
import { collectFilesRecursive } from '../adapters/shared.js'
import { resolveWorkspace } from '../workspace.js'

interface SessionsShowOptions {
  homeDir?: string
  stream?: boolean
}

interface OpenCodeReadInput {
  sessionId: string
  directory: string
}

interface SessionsShowDeps {
  readOpenCodeMessages?: (input: OpenCodeReadInput) => Promise<unknown>
  writeOutput?: (chunk: string) => boolean | void | Promise<boolean | void>
}

interface StoredSessionRow {
  agent: string
  source_path: string
}

const MAX_SHOW_BYTES = 50 * 1024 * 1024
const JSONL_AGENTS = new Set(['claude', 'codex', 'cursor', 'gemini', 'grok', 'pi'])

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

function jsonlFiles(sourcePath: string, agent: string, enforceShowLimit = true): string[] {
  if (!fs.existsSync(sourcePath)) throw new Error(`${agent} session 源不存在：${sourcePath}`)
  const stat = fs.statSync(sourcePath)
  const files = stat.isDirectory()
    ? collectFilesRecursive(sourcePath, (filePath) => filePath.endsWith('.jsonl')
      || (agent === 'gemini' && path.extname(filePath).toLowerCase() === '.json'))
    : [sourcePath]
  if (files.length === 0) throw new Error(`${agent} session 没有 JSONL 文件：${sourcePath}`)
  const totalBytes = files.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0)
  if (enforceShowLimit && totalBytes > MAX_SHOW_BYTES) {
    throw new Error(`${agent} session 超过 50 MiB，暂不支持一次性输出：${sourcePath}`)
  }
  return files
}

function isBrokenPipe(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPIPE'
}

function writeStdout(chunk: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error | null) => {
      if (settled) return
      settled = true
      process.stdout.off('error', onError)
      if (!error) {
        resolve(true)
      } else if (isBrokenPipe(error)) {
        resolve(false)
      } else {
        reject(error)
      }
    }
    const onError = (error: Error) => finish(error)

    process.stdout.once('error', onError)
    try {
      process.stdout.write(chunk, (error) => finish(error))
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function writeStreamRecord(
  sessionId: string,
  agent: string,
  index: number,
  record: unknown,
  writeOutput: NonNullable<SessionsShowDeps['writeOutput']>,
): Promise<boolean> {
  const chunk = `${JSON.stringify({ sessionId, agent, index, record })}\n`
  try {
    return (await writeOutput(chunk)) !== false
  } catch (error) {
    if (isBrokenPipe(error)) return false
    throw error
  }
}

async function streamJsonlRecords(
  sessionId: string,
  agent: string,
  sourcePath: string,
  writeOutput: NonNullable<SessionsShowDeps['writeOutput']>,
): Promise<void> {
  let recordIndex = 0
  for (const filePath of jsonlFiles(sourcePath, agent, false)) {
    if (agent === 'gemini' && path.extname(filePath).toLowerCase() === '.json') {
      let record: unknown
      try {
        record = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      } catch {
        throw new Error(`${agent} JSON 解析失败：${filePath}`)
      }
      const shouldContinue = await writeStreamRecord(
        sessionId,
        agent,
        recordIndex,
        record,
        writeOutput,
      )
      if (!shouldContinue) return
      recordIndex++
      continue
    }
    const input = fs.createReadStream(filePath, { encoding: 'utf8' })
    const lines = readline.createInterface({ input, crlfDelay: Infinity })
    let lineNumber = 0
    try {
      for await (const rawLine of lines) {
        lineNumber++
        const line = rawLine.replace(/^\uFEFF/, '')
        if (!line.trim()) continue
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          throw new Error(`${agent} JSONL 解析失败：${filePath}:${lineNumber}`)
        }
        const shouldContinue = await writeStreamRecord(
          sessionId,
          agent,
          recordIndex,
          record,
          writeOutput,
        )
        recordIndex++
        if (!shouldContinue) return
      }
    } finally {
      lines.close()
      input.destroy()
    }
  }
  if (recordIndex === 0) throw new Error(`${agent} session 没有可解析内容：${sourcePath}`)
}

async function streamRecords(
  sessionId: string,
  agent: string,
  records: Iterable<unknown>,
  writeOutput: NonNullable<SessionsShowDeps['writeOutput']>,
  emptyMessage: string,
): Promise<void> {
  let recordIndex = 0
  for (const record of records) {
    const shouldContinue = await writeStreamRecord(
      sessionId,
      agent,
      recordIndex,
      record,
      writeOutput,
    )
    recordIndex++
    if (!shouldContinue) return
  }
  if (recordIndex === 0) throw new Error(emptyMessage)
}

function readJsonlRecords(sourcePath: string, agent: string): unknown[] {
  const records: unknown[] = []
  for (const filePath of jsonlFiles(sourcePath, agent)) {
    if (agent === 'gemini' && path.extname(filePath).toLowerCase() === '.json') {
      try {
        records.push(JSON.parse(fs.readFileSync(filePath, 'utf8')))
      } catch {
        throw new Error(`${agent} JSON 解析失败：${filePath}`)
      }
      continue
    }
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

async function streamCopilotSession(
  sessionId: string,
  sourcePath: string,
  writeOutput: NonNullable<SessionsShowDeps['writeOutput']>,
): Promise<void> {
  const eventsPath = path.basename(sourcePath) === 'events.jsonl'
    ? sourcePath
    : path.join(path.dirname(sourcePath), 'events.jsonl')
  if (fs.existsSync(eventsPath)) {
    await streamJsonlRecords(sessionId, 'copilot', eventsPath, writeOutput)
    return
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
      .iterate(sessionId)
    await streamRecords(
      sessionId,
      'copilot',
      turns,
      writeOutput,
      `Copilot session 只有 metadata，源端未持久化对话：${sessionId}`,
    )
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
  const writeOutput = deps.writeOutput ?? writeStdout
  if (session.agent === 't3' || session.agent === 'antigravity') {
    const [source] = await readSessionEventSources([{ id: sessionId, agent: session.agent }], { homeDir: opts.homeDir })
    if (source.errorCode && source.status !== 'empty') throw new Error(source.errorMessage)
    if (opts.stream) return streamRecords(sessionId, session.agent, source.events, writeOutput, '会话为空')
    console.log(JSON.stringify({ sessionId, agent: session.agent, records: source.events }, null, 2))
    return
  }
  if (JSONL_AGENTS.has(session.agent)) {
    if (opts.stream) {
      await streamJsonlRecords(sessionId, session.agent, session.source_path, writeOutput)
      return
    }
    const records = readJsonlRecords(session.source_path, session.agent)
    console.log(JSON.stringify({ sessionId, agent: session.agent, records }, null, 2))
    return
  }
  if (session.agent === 'copilot') {
    if (opts.stream) {
      await streamCopilotSession(sessionId, session.source_path, writeOutput)
      return
    }
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
  if (opts.stream) {
    await streamRecords(
      sessionId,
      session.agent,
      Array.isArray(messages) ? messages : [messages],
      writeOutput,
      `OpenCode session 没有可解析内容：${sessionId}`,
    )
    return
  }
  console.log(JSON.stringify({ sessionId, agent: session.agent, directory, messages }, null, 2))
}
