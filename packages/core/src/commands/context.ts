import fs from 'node:fs'
import {
  cleanupStaleSessionContextRuns,
  closeSessionContextRun,
  createSessionContextRun,
  getSessionContextStatus,
  listSessionContextProofs,
  listSessionContextOutcomes,
  listSessionContextSessions,
  locateSessionContextEvent,
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

interface ContextPageOptions {
  cursor?: string
  limit?: number
}

interface ContextOutcomeOptions extends ContextPageOptions {
  status?: 'matched' | 'not_matched' | 'unknown'
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
  const execution = await runSessionQuery(parseQueryInput(options), {
    homeDir: deps.homeDir,
    now: deps.now,
    retainMatchedSources: false,
  })
  const summary = createSessionContextRun(execution, {
    parentDir: deps.parentDir,
    now: deps.now,
  })
  output(deps, {
    ...summary,
    readCommand: 'memory-manager context read <run-id> --session <session-id> --part <part>',
    sessionsCommand: `memory-manager context sessions ${summary.runId}`,
    outcomesCommand: `memory-manager context outcomes ${summary.runId}`,
    proofsCommand: `memory-manager context proofs ${summary.runId} --session <session-id>`,
    locateCommand: `memory-manager context locate ${summary.runId} --session <session-id> --event <index>`,
    statusCommand: `memory-manager context status ${summary.runId}`,
    closeCommand: `memory-manager context close ${summary.runId}`,
  })
}

export async function runContextRead(
  runId: string,
  options: { session: string; part: number },
  deps: ContextCommandDeps = {},
): Promise<void> {
  cleanupStaleSessionContextRuns({ parentDir: deps.parentDir, now: deps.now })
  output(deps, await readSessionContextPart(
    runId,
    options.session,
    options.part,
    {
      parentDir: deps.parentDir,
      homeDir: deps.homeDir,
      now: deps.now,
    },
  ))
}

export function runContextStatus(
  runId: string,
  deps: ContextCommandDeps = {},
): void {
  cleanupStaleSessionContextRuns({ parentDir: deps.parentDir, now: deps.now })
  output(deps, getSessionContextStatus(runId, deps.parentDir))
}

export function runContextSessions(
  runId: string,
  options: ContextPageOptions,
  deps: ContextCommandDeps = {},
): void {
  cleanupStaleSessionContextRuns({ parentDir: deps.parentDir, now: deps.now })
  output(deps, listSessionContextSessions(runId, options, deps.parentDir))
}

export function runContextOutcomes(
  runId: string,
  options: ContextOutcomeOptions,
  deps: ContextCommandDeps = {},
): void {
  cleanupStaleSessionContextRuns({ parentDir: deps.parentDir, now: deps.now })
  output(deps, listSessionContextOutcomes(runId, options, deps.parentDir))
}

export function runContextProofs(
  runId: string,
  options: ContextPageOptions & { session: string },
  deps: ContextCommandDeps = {},
): void {
  cleanupStaleSessionContextRuns({ parentDir: deps.parentDir, now: deps.now })
  output(deps, listSessionContextProofs(
    runId,
    options.session,
    options,
    deps.parentDir,
  ))
}

export async function runContextLocate(
  runId: string,
  options: { session: string; event: number },
  deps: ContextCommandDeps = {},
): Promise<void> {
  cleanupStaleSessionContextRuns({ parentDir: deps.parentDir, now: deps.now })
  output(deps, await locateSessionContextEvent(
    runId,
    options.session,
    options.event,
    {
      parentDir: deps.parentDir,
      homeDir: deps.homeDir,
      now: deps.now,
    },
  ))
}

export function runContextCleanup(deps: ContextCommandDeps = {}): void {
  const removedRunIds = cleanupStaleSessionContextRuns({
    parentDir: deps.parentDir,
    now: deps.now,
  })
  output(deps, {
    removed: removedRunIds.length,
    removedRunIds,
  })
}

export function runContextClose(
  runId: string,
  deps: ContextCommandDeps = {},
): void {
  cleanupStaleSessionContextRuns({ parentDir: deps.parentDir, now: deps.now })
  output(deps, closeSessionContextRun(runId, deps.parentDir))
}
