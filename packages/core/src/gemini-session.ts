import fs from 'node:fs'
import path from 'node:path'

export interface GeminiStoredMessage {
  id: string
  type?: string
  content?: unknown
  timestamp?: unknown
  toolCalls?: unknown
  sourceLocator: string
}

export interface GeminiSessionSnapshot {
  sessionId?: string
  projectHash?: string
  startTime?: string
  lastUpdated?: string
  summary?: string
  cwd?: string
  gitRoot?: string
  branch?: string
  headCommit?: string
  messages: GeminiStoredMessage[]
}

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function isMessageRecord(value: JsonObject): value is JsonObject & { id: string } {
  return typeof value.id === 'string' && !('$patch' in value)
}

function applyMessagePatch(
  messages: Map<string, GeminiStoredMessage>,
  patch: JsonObject,
): void {
  if (typeof patch.id !== 'string') return
  const current = messages.get(patch.id)
  if (!current) return
  if ('content' in patch) current.content = patch.content
  if (Array.isArray(patch.toolCalls) && Array.isArray(current.toolCalls)) {
    const calls = current.toolCalls.map((call) => asObject(call))
    for (const toolCallPatchValue of patch.toolCalls) {
      const toolCallPatch = asObject(toolCallPatchValue)
      if (!toolCallPatch || typeof toolCallPatch.id !== 'string') continue
      const index = calls.findIndex((call) => call?.id === toolCallPatch.id)
      if (index < 0 || !('result' in toolCallPatch)) continue
      calls[index] = { ...calls[index], result: toolCallPatch.result }
    }
    current.toolCalls = calls
  }
}

function addMessages(
  messages: Map<string, GeminiStoredMessage>,
  values: unknown,
  sourceLocator: string,
  replace: boolean,
): void {
  if (!Array.isArray(values)) return
  if (replace) messages.clear()
  values.forEach((value, index) => {
    const record = asObject(value)
    if (!record || !isMessageRecord(record)) return
    messages.set(record.id, {
      ...record,
      id: record.id,
      sourceLocator: `${sourceLocator}[${index}]`,
    })
  })
}

function applyRecord(
  record: JsonObject,
  sourceLocator: string,
  metadata: JsonObject,
  messages: Map<string, GeminiStoredMessage>,
): void {
  if (typeof record.$rewindTo === 'string') {
    const ids = [...messages.keys()]
    const rewindIndex = ids.indexOf(record.$rewindTo)
    const removedIds = rewindIndex < 0 ? ids : ids.slice(rewindIndex)
    for (const id of removedIds) messages.delete(id)
    return
  }

  const patch = asObject(record.$patch)
  if (patch) {
    if (typeof patch.id === 'string') applyMessagePatch(messages, patch)
    if (Array.isArray(patch.updates)) {
      for (const value of patch.updates) {
        const update = asObject(value)
        if (update) applyMessagePatch(messages, update)
      }
    }
    if (Array.isArray(patch.removeIds)) {
      for (const id of patch.removeIds) {
        if (typeof id === 'string') messages.delete(id)
      }
    }
    if (Array.isArray(patch.orderIds)) {
      const orderedIds = patch.orderIds.filter(
        (id): id is string => typeof id === 'string' && messages.has(id),
      )
      const orderedSet = new Set(orderedIds)
      const remaining = [...messages.entries()].filter(([id]) => !orderedSet.has(id))
      const ordered = orderedIds.flatMap((id) => {
        const message = messages.get(id)
        return message ? [[id, message] as const] : []
      })
      messages.clear()
      for (const [id, message] of [...remaining, ...ordered]) messages.set(id, message)
    }
    return
  }

  const metadataUpdate = asObject(record.$set)
  if (metadataUpdate) {
    Object.assign(metadata, metadataUpdate)
    if (Array.isArray(metadataUpdate.messages)) {
      addMessages(messages, metadataUpdate.messages, `${sourceLocator}.$set.messages`, true)
    }
    return
  }

  if (isMessageRecord(record)) {
    messages.set(record.id, { ...record, id: record.id, sourceLocator })
    return
  }

  if (asString(record.sessionId) && asString(record.projectHash)) {
    Object.assign(metadata, record)
    if (Array.isArray(record.messages)) {
      addMessages(messages, record.messages, `${sourceLocator}.messages`, false)
    }
  }
}

function finalizeSnapshot(metadata: JsonObject, messages: Map<string, GeminiStoredMessage>): GeminiSessionSnapshot {
  return {
    sessionId: asString(metadata.sessionId),
    projectHash: asString(metadata.projectHash),
    startTime: asString(metadata.startTime),
    lastUpdated: asString(metadata.lastUpdated),
    summary: asString(metadata.summary),
    cwd: asString(metadata.cwd),
    gitRoot: asString(metadata.gitRoot) ?? asString(metadata.git_root),
    branch: asString(metadata.branch) ?? asString(metadata.head_branch),
    headCommit: asString(metadata.headCommit) ?? asString(metadata.head_commit),
    messages: [...messages.values()],
  }
}

export function readGeminiSession(sourcePath: string): GeminiSessionSnapshot {
  const content = fs.readFileSync(sourcePath, 'utf8')
  if (path.extname(sourcePath).toLowerCase() === '.json') {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error(`Gemini JSON 解析失败：${sourcePath}`)
    }
    const record = asObject(parsed)
    if (!record) throw new Error(`Gemini Session 不是对象：${sourcePath}`)
    const metadata = { ...record }
    const messages = new Map<string, GeminiStoredMessage>()
    addMessages(messages, record.messages, 'messages', true)
    return finalizeSnapshot(metadata, messages)
  }

  const metadata: JsonObject = {}
  const messages = new Map<string, GeminiStoredMessage>()
  const lines = content.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (!line.trim()) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`Gemini JSONL 解析失败：${sourcePath}:${index + 1}`)
    }
    const record = asObject(value)
    if (!record) throw new Error(`Gemini JSONL 事件不是对象：${sourcePath}:${index + 1}`)
    applyRecord(record, `line:${index + 1}`, metadata, messages)
  })
  return finalizeSnapshot(metadata, messages)
}
