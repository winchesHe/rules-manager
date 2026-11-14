import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { SourceRevision } from './evidence-coverage.js'

export interface GrokTranscriptEvent {
  kind: 'message' | 'tool_call' | 'tool_result'
  role: 'user' | 'assistant' | 'tool'
  content: unknown
  sourceLocator: string
  timestamp?: string
  toolCallId?: string
  toolName?: string
}

export interface GrokSessionSnapshot {
  sessionId: string
  title?: string
  updatedAt?: string
  cwd?: string
  gitRoot?: string
  gitRemote?: string
  branch?: string
  headCommit?: string
  events: GrokTranscriptEvent[]
  sourceRevision: SourceRevision
}

type JsonObject = Record<string, unknown>

interface FileMark {
  path: string
  size: number
  mtimeMs: number
}

interface PendingMessage {
  role: 'user' | 'assistant'
  key?: string
  content: string
  timestamp?: string
  firstLine: number
  lastLine: number
}

interface PendingToolResult {
  id: string
  name?: string
  outputs: unknown[]
  timestamp?: string
  line: number
  terminal: boolean
}

const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function timestampOf(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value
    const date = new Date(milliseconds)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return undefined
}

function textContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.map(textContent).filter((part): part is string => part !== undefined)
    return parts.length > 0 ? parts.join('') : undefined
  }
  const record = asObject(value)
  if (!record) return undefined
  if (record.type === 'text' && typeof record.text === 'string') return record.text
  if (typeof record.text === 'string') return record.text
  if ('content' in record) return textContent(record.content)
  return undefined
}

function sessionDirectory(sourcePath: string): string {
  return path.basename(sourcePath) === 'updates.jsonl'
    || path.basename(sourcePath) === 'chat_history.jsonl'
    ? path.dirname(sourcePath)
    : sourcePath
}

function captureFileMarks(directory: string): FileMark[] {
  return ['summary.json', 'updates.jsonl', 'chat_history.jsonl']
    .map((name) => path.join(directory, name))
    .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
    .map((filePath) => {
      const stat = fs.statSync(filePath)
      return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs }
    })
}

function revisionFor(directory: string, before: FileMark[]): SourceRevision {
  const after = captureFileMarks(directory)
  const fingerprintOf = (files: FileMark[]) => files.map((file) => ({
    path: path.basename(file.path),
    size: file.size,
    mtimeMs: file.mtimeMs,
  }))
  return {
    kind: 'jsonl-watermark',
    fingerprint: crypto.createHash('sha256')
      .update(JSON.stringify(fingerprintOf(before)))
      .digest('hex'),
    changedDuringRun: JSON.stringify(fingerprintOf(before)) !== JSON.stringify(fingerprintOf(after)),
  }
}

function readSummary(directory: string): JsonObject {
  const summaryPath = path.join(directory, 'summary.json')
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  } catch {
    throw new Error(`Grok summary.json 读取失败：${summaryPath}`)
  }
  const summary = asObject(value)
  if (!summary) throw new Error(`Grok summary.json 不是对象：${summaryPath}`)
  return summary
}

function summaryPathValue(
  summary: JsonObject,
  field: string,
  nestedField?: string,
): string | undefined {
  const direct = asString(summary[field])
  if (direct) return direct
  const nested = nestedField ? asObject(summary[nestedField]) : undefined
  return nested ? asString(nested[field]) : undefined
}

function flushPendingMessage(
  events: GrokTranscriptEvent[],
  pending: PendingMessage | undefined,
): void {
  if (!pending || !pending.content) return
  const range = pending.firstLine === pending.lastLine
    ? `updates.jsonl:${pending.firstLine}`
    : `updates.jsonl:${pending.firstLine}-${pending.lastLine}`
  events.push({
    kind: 'message',
    role: pending.role,
    content: pending.content,
    sourceLocator: range,
    ...(pending.timestamp ? { timestamp: pending.timestamp } : {}),
  })
}

function toolCallFields(value: JsonObject): {
  id?: string
  name?: string
  input: unknown
} {
  return {
    id: asString(value.toolCallId) ?? asString(value.tool_call_id) ?? asString(value.id),
    name: asString(value.name)
      ?? asString(value.toolName)
      ?? asString(value.title)
      ?? asString(value.kind),
    input: value.rawInput ?? value.input ?? value.arguments ?? value.args ?? {},
  }
}

function addToolResult(
  events: GrokTranscriptEvent[],
  result: PendingToolResult,
): void {
  if (result.outputs.length === 0) return
  const content = result.outputs.length === 1 ? result.outputs[0] : result.outputs
  events.push({
    kind: 'tool_result',
    role: 'tool',
    content,
    sourceLocator: `updates.jsonl:${result.line}`,
    ...(result.timestamp ? { timestamp: result.timestamp } : {}),
    toolCallId: result.id,
    ...(result.name ? { toolName: result.name } : {}),
  })
}

function parseUpdateLog(filePath: string): GrokTranscriptEvent[] {
  const contents = fs.readFileSync(filePath, 'utf8')
  const events: GrokTranscriptEvent[] = []
  const toolResults = new Map<string, PendingToolResult>()
  let pendingMessage: PendingMessage | undefined

  contents.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    const lineNumber = index + 1
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`Grok updates.jsonl 解析失败：${filePath}:${lineNumber}`)
    }
    const record = asObject(value)
    if (!record) throw new Error(`Grok updates.jsonl 事件不是对象：${filePath}:${lineNumber}`)
    if (record.method !== 'session/update' && record.method !== '_x.ai/session/update') return

    const params = asObject(record.params)
    const update = asObject(params?.update)
    if (!update || typeof update.sessionUpdate !== 'string') return
    const updateType = update.sessionUpdate
    const meta = asObject(params?._meta) ?? asObject(update._meta)
    const timestamp = timestampOf(
      meta?.agentTimestampMs,
      meta?.timestamp,
      update.timestamp,
      record.timestamp,
    )

    if (updateType === 'user_message_chunk' || updateType === 'agent_message_chunk') {
      const role = updateType === 'user_message_chunk' ? 'user' : 'assistant'
      const content = update.content ?? update.text
      const text = textContent(content)
      const key = asString(meta?.messageId)
        ?? asString(meta?.promptId)
        ?? (typeof meta?.promptIndex === 'number' ? `prompt:${meta.promptIndex}` : undefined)
      const samePending = pendingMessage?.role === role
        && (pendingMessage.key === key || (!pendingMessage.key && !key))
      if (text !== undefined && samePending && pendingMessage) {
        pendingMessage.content += text
        pendingMessage.lastLine = lineNumber
        pendingMessage.timestamp = timestamp ?? pendingMessage.timestamp
        return
      }
      flushPendingMessage(events, pendingMessage)
      pendingMessage = undefined
      if (text !== undefined) {
        pendingMessage = {
          role,
          ...(key ? { key } : {}),
          content: text,
          ...(timestamp ? { timestamp } : {}),
          firstLine: lineNumber,
          lastLine: lineNumber,
        }
      } else if (content !== undefined) {
        events.push({
          kind: 'message',
          role,
          content,
          sourceLocator: `updates.jsonl:${lineNumber}`,
          ...(timestamp ? { timestamp } : {}),
        })
      }
      return
    }

    flushPendingMessage(events, pendingMessage)
    pendingMessage = undefined

    if (updateType === 'tool_call') {
      const fields = toolCallFields(update)
      if (!fields.id) return
      events.push({
        kind: 'tool_call',
        role: 'assistant',
        content: fields.input,
        sourceLocator: `updates.jsonl:${lineNumber}`,
        ...(timestamp ? { timestamp } : {}),
        toolCallId: fields.id,
        ...(fields.name ? { toolName: fields.name } : {}),
      })
      const initialOutput = update.rawOutput ?? update.output ?? update.result
      if (initialOutput !== undefined) {
        toolResults.set(fields.id, {
          id: fields.id,
          ...(fields.name ? { name: fields.name } : {}),
          outputs: [initialOutput],
          ...(timestamp ? { timestamp } : {}),
          line: lineNumber,
          terminal: false,
        })
      }
      return
    }

    if (updateType === 'tool_call_update') {
      const fields = asObject(update.fields) ?? update
      const call = toolCallFields(update)
      const id = call.id ?? asString(fields.toolCallId) ?? asString(fields.tool_call_id)
      if (!id) return
      const output = fields.rawOutput
        ?? fields.output
        ?? fields.result
        ?? fields.error
        ?? fields.content
      const status = asString(fields.status) ?? asString(update.status)
      const pending = toolResults.get(id) ?? {
        id,
        ...(call.name ? { name: call.name } : {}),
        outputs: [],
        ...(timestamp ? { timestamp } : {}),
        line: lineNumber,
        terminal: false,
      }
      if (output !== undefined) {
        const key = JSON.stringify(output)
        if (!pending.outputs.some((item) => JSON.stringify(item) === key)) {
          pending.outputs.push(output)
        }
      }
      pending.name = pending.name ?? call.name
      pending.timestamp = timestamp ?? pending.timestamp
      pending.line = lineNumber
      pending.terminal = Boolean(status && TERMINAL_TOOL_STATUSES.has(status))
      toolResults.set(id, pending)
      if (pending.terminal) {
        addToolResult(events, pending)
        toolResults.delete(id)
      }
    }
  })

  flushPendingMessage(events, pendingMessage)
  for (const result of toolResults.values()) addToolResult(events, result)
  return events
}

function parseChatHistory(filePath: string): GrokTranscriptEvent[] {
  const contents = fs.readFileSync(filePath, 'utf8')
  const events: GrokTranscriptEvent[] = []
  contents.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    const lineNumber = index + 1
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`Grok chat_history.jsonl 解析失败：${filePath}:${lineNumber}`)
    }
    const record = asObject(value)
    if (!record) throw new Error(`Grok chat_history.jsonl 事件不是对象：${filePath}:${lineNumber}`)
    const type = asString(record.type)?.toLowerCase()
    if (type === 'system' || type === 'reasoning' || type === 'developer') return
    const role = record.role === 'user' || type === 'user'
      ? 'user'
      : record.role === 'assistant' || type === 'assistant'
        ? 'assistant'
        : undefined
    const content = record.content ?? asObject(record.message)?.content
    if (!role || content === undefined || content === '') return
    events.push({
      kind: 'message',
      role,
      content,
      sourceLocator: `chat_history.jsonl:${lineNumber}`,
      ...(timestampOf(record.timestamp) ? { timestamp: timestampOf(record.timestamp) } : {}),
    })
    if (Array.isArray(record.tool_calls)) {
      for (const toolValue of record.tool_calls) {
        const tool = asObject(toolValue)
        if (!tool) continue
        const fields = toolCallFields(tool)
        if (!fields.id) continue
        events.push({
          kind: 'tool_call',
          role: 'assistant',
          content: fields.input,
          sourceLocator: `chat_history.jsonl:${lineNumber}.tool_calls`,
          toolCallId: fields.id,
          ...(fields.name ? { toolName: fields.name } : {}),
        })
        if (tool.result !== undefined) {
          events.push({
            kind: 'tool_result',
            role: 'tool',
            content: tool.result,
            sourceLocator: `chat_history.jsonl:${lineNumber}.tool_calls.result`,
            toolCallId: fields.id,
            ...(fields.name ? { toolName: fields.name } : {}),
          })
        }
      }
    }
  })
  return events
}

export function readGrokSession(
  sourcePath: string,
  sessionId: string,
  afterSnapshot?: (sourcePath: string) => void,
): GrokSessionSnapshot {
  const directory = sessionDirectory(sourcePath)
  const before = captureFileMarks(directory)
  afterSnapshot?.(sourcePath)
  const summary = readSummary(directory)
  const summaryPath = path.join(directory, 'summary.json')
  const info = asObject(summary.info)
  const id = asString(info?.id) ?? asString(summary.session_id) ?? sessionId
  const updatesPath = path.join(directory, 'updates.jsonl')
  const chatHistoryPath = path.join(directory, 'chat_history.jsonl')
  let events: GrokTranscriptEvent[] = []
  if (fs.existsSync(updatesPath)) events = parseUpdateLog(updatesPath)
  if (!events.some((event) => event.kind === 'message') && fs.existsSync(chatHistoryPath)) {
    events = parseChatHistory(chatHistoryPath)
  }
  const title = asString(summary.generated_title) ?? asString(summary.session_summary)
  const gitRemotes = Array.isArray(summary.git_remotes) ? summary.git_remotes : []
  const cwd = asString(info?.cwd) ?? asString(summary.cwd)
  const gitRoot = asString(summary.git_root_dir) ?? asString(summary.gitRoot)
  const branch = asString(summary.head_branch) ?? asString(summary.branch)
  const headCommit = asString(summary.head_commit) ?? asString(summary.headCommit)
  const gitRemote = gitRemotes.length > 0 ? asString(gitRemotes[0]) : undefined
  return {
    sessionId: id,
    ...(title ? { title } : {}),
    ...(asString(summary.updated_at) ? { updatedAt: asString(summary.updated_at) } : {}),
    ...(cwd ? { cwd } : {}),
    ...(gitRoot ? { gitRoot } : {}),
    ...(branch ? { branch } : {}),
    ...(headCommit ? { headCommit } : {}),
    ...(gitRemote ? { gitRemote } : {}),
    events,
    sourceRevision: revisionFor(directory, before),
  }
}

export function hashGrokSession(sourcePath: string): string {
  const directory = sessionDirectory(sourcePath)
  const fileNames = ['summary.json', 'updates.jsonl', 'chat_history.jsonl']
  const hash = crypto.createHash('sha256')
  for (const name of fileNames) {
    const filePath = path.join(directory, name)
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue
    hash.update(name)
    hash.update(fs.readFileSync(filePath))
  }
  return hash.digest('hex')
}

export function grokSourcePath(sessionDirectoryPath: string): string {
  const updates = path.join(sessionDirectoryPath, 'updates.jsonl')
  return fs.existsSync(updates) ? updates : path.join(sessionDirectoryPath, 'chat_history.jsonl')
}

export function isGrokSessionDirectory(directory: string): boolean {
  return fs.existsSync(path.join(directory, 'updates.jsonl'))
    || fs.existsSync(path.join(directory, 'chat_history.jsonl'))
}

export function grokSessionId(directory: string): string | undefined {
  try {
    const summary = readSummary(directory)
    const info = asObject(summary.info)
    return asString(info?.id) ?? asString(summary.session_id) ?? path.basename(directory)
  } catch {
    const fallback = path.basename(directory)
    return fallback || undefined
  }
}

export function grokSessionTitle(sourcePath: string): string | null {
  try {
    const summary = readSummary(sessionDirectory(sourcePath))
    return asString(summary.generated_title) ?? asString(summary.session_summary) ?? null
  } catch {
    return null
  }
}
