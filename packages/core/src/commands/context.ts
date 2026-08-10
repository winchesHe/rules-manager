import fs from 'node:fs'
import {
  cleanupStaleSessionContextRuns,
  closeSessionContextRun,
  createSessionContextRunWriter,
  getSessionContextStatus,
  readSessionContextPart,
} from '../session-context-run.js'
import { runSessionQuery } from '../session-query.js'

interface ContextPrepareOptions {
  queryJson?: string
  queryFile?: string
}

interface ContextCommandDeps {
  parentDir?: string
  homeDir?: string
  now?: Date
  writeOutput?: (value: unknown) => void
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function output(deps: ContextCommandDeps, value: unknown): void {
  ;(deps.writeOutput ?? writeJson)(value)
}

function parseQueryInput(options: ContextPrepareOptions): unknown {
  if (options.queryJson && options.queryFile) {
    throw new Error('--query-json 与 --query-file 不能同时使用')
  }
  if (!options.queryJson && !options.queryFile) {
    throw new Error('必须提供 --query-json 或 --query-file')
  }
  const raw = options.queryJson ?? fs.readFileSync(options.queryFile!, 'utf8')
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('Session Query 不是合法 JSON')
  }
}

export async function runContextPrepare(
  options: ContextPrepareOptions,
  deps: ContextCommandDeps = {},
): Promise<void> {
  cleanupStaleSessionContextRuns({ parentDir: deps.parentDir, now: deps.now })
  const writer = createSessionContextRunWriter({
    parentDir: deps.parentDir,
    now: deps.now,
  })
  let summary: ReturnType<typeof writer.finalize>
  try {
    const execution = await runSessionQuery(parseQueryInput(options), {
      homeDir: deps.homeDir,
      now: deps.now,
      retainMatchedSources: false,
      onMatchedSource: writer.writeMatchedSession,
    })
    summary = writer.finalize(execution)
  } catch (error) {
    writer.cleanup()
    throw error
  }
  output(deps, {
    ...summary,
    readCommand: 'memory-manager context read <run-id> --session <session-id> --part <part>',
    statusCommand: `memory-manager context status ${summary.runId}`,
    closeCommand: `memory-manager context close ${summary.runId}`,
  })
}

export function runContextRead(
  runId: string,
  options: { session: string; part: number },
  deps: ContextCommandDeps = {},
): void {
  cleanupStaleSessionContextRuns({ parentDir: deps.parentDir, now: deps.now })
  output(deps, readSessionContextPart(
    runId,
    options.session,
    options.part,
    deps.parentDir,
  ))
}

export function runContextStatus(
  runId: string,
  deps: ContextCommandDeps = {},
): void {
  cleanupStaleSessionContextRuns({ parentDir: deps.parentDir, now: deps.now })
  output(deps, getSessionContextStatus(runId, deps.parentDir))
}

export function runContextClose(
  runId: string,
  deps: ContextCommandDeps = {},
): void {
  cleanupStaleSessionContextRuns({ parentDir: deps.parentDir, now: deps.now })
  output(deps, closeSessionContextRun(runId, deps.parentDir))
}
