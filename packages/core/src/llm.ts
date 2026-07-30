import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { LlmEffort, LlmProvider } from './config.js'
import { isRunCancelledError, RunCancelledError, throwIfAborted } from './abort.js'

export const candidateRulesSchema = z.array(z.object({
  scope: z.enum(['global', 'project']),
  project_slug: z.string().min(1).optional(),
  rule_text: z.string().min(1),
  confidence_level: z.enum(['low', 'medium', 'high']),
  reasoning: z.string().min(1),
  evidence_refs: z.array(z.string()),
}))

export type CandidateRule = z.infer<typeof candidateRulesSchema>[number]

export interface LlmRequestOptions {
  fastMode?: boolean
  maxRetries?: number
  signal?: AbortSignal
  onEvent?: (event: LlmStreamEvent) => void
  cwd?: string
  maxTurns?: number
  tools?: string[]
  outputSchemaPath?: string
}

export type AgentActivityKind = 'thinking' | 'read' | 'search' | 'shell' | 'tool'

export interface AgentActivity {
  id: string
  kind: AgentActivityKind
  label: string
  detail?: string
  status?: 'running' | 'completed'
}

export type LlmStreamEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'activity'; activity: AgentActivity }
  | { type: 'retry'; message: string; attempt: number }

const MAX_ACTIVITY_DETAIL_LENGTH = 1_000
const MAX_THINKING_DETAIL_LENGTH = 8_000
let llmCallSequence = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringField(
  value: unknown,
  keys: string[],
): string | undefined {
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) {
      return activityDetail(candidate)
    }
  }
  return undefined
}

function rawStringField(
  value: unknown,
  keys: string[],
): string | undefined {
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return undefined
}

function activityDetail(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.slice(0, MAX_ACTIVITY_DETAIL_LENGTH)
}

function thinkingDetail(value: string): string | undefined {
  const normalized = value.trim()
  if (!normalized) return undefined
  return normalized.slice(0, MAX_THINKING_DETAIL_LENGTH)
}

function humanizeToolName(value: string): string {
  const leaf = value.split(/[:./]|__/).filter(Boolean).at(-1) ?? value
  return leaf
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function agentActivity(
  id: string,
  kind: AgentActivityKind,
  label: string,
  detail?: string,
  status?: AgentActivity['status'],
): AgentActivity {
  return {
    id,
    kind,
    label,
    ...(detail ? { detail } : {}),
    ...(status ? { status } : {}),
  }
}

function normalizeToolActivity(
  id: string,
  name: string,
  input: unknown,
  status?: AgentActivity['status'],
): AgentActivity {
  const lowerName = name.trim().toLowerCase()
  if (['read', 'read_file', 'view_file'].includes(lowerName)) {
    return agentActivity(
      id,
      'read',
      'Read',
      stringField(input, ['file_path', 'filePath', 'path']),
      status,
    )
  }
  if (['grep', 'glob', 'search', 'websearch', 'web_search'].includes(lowerName)) {
    return agentActivity(
      id,
      'search',
      'Search',
      stringField(input, ['pattern', 'query', 'path']),
      status,
    )
  }
  if (['bash', 'shell', 'exec', 'exec_command', 'command'].includes(lowerName)) {
    return agentActivity(
      id,
      'shell',
      'Shell',
      stringField(input, ['command', 'cmd']),
      status,
    )
  }
  return agentActivity(id, 'tool', humanizeToolName(name) || 'Tool', undefined, status)
}

function normalizeClaudeToolActivity(
  block: unknown,
  status?: AgentActivity['status'],
): AgentActivity | undefined {
  if (!isRecord(block) || block.type !== 'tool_use') return undefined
  if (typeof block.id !== 'string' || typeof block.name !== 'string') return undefined
  return normalizeToolActivity(block.id, block.name, block.input, status)
}

function normalizeCodexActivity(event: Record<string, unknown>): AgentActivity | undefined {
  if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined
  if (!isRecord(event.item)) return undefined
  const item = event.item
  const itemType = typeof item.type === 'string' ? item.type : ''
  const id = typeof item.id === 'string' ? item.id : undefined
  if (!id) return undefined
  const status = event.type === 'item.completed' ? 'completed' : 'running'

  if (itemType === 'reasoning') {
    const detail = status === 'completed'
      ? thinkingDetail(rawStringField(item, ['summary', 'text']) ?? '')
      : undefined
    return agentActivity(id, 'thinking', 'Thinking', detail, status)
  }
  if (itemType === 'web_search' || itemType === 'webSearch') {
    return agentActivity(id, 'search', 'Search', stringField(item, ['query']), status)
  }
  if (itemType === 'command_execution' || itemType === 'commandExecution') {
    const rawCommand = Array.isArray(item.command)
      ? item.command.filter((part): part is string => typeof part === 'string').join(' ')
      : typeof item.command === 'string' ? item.command : ''
    const detail = activityDetail(rawCommand)
    if (/(?:^|\s)(?:rtk\s+)?(?:rg|grep|find|fd)\b/.test(rawCommand)) {
      return agentActivity(id, 'search', 'Search', detail, status)
    }
    if (/(?:^|\s)(?:rtk\s+)?(?:cat|sed|head|tail|bat)\b/.test(rawCommand)) {
      return agentActivity(id, 'read', 'Read', detail, status)
    }
    return agentActivity(id, 'shell', 'Shell', detail, status)
  }
  if (itemType === 'mcp_tool_call' || itemType === 'mcpToolCall') {
    const name = stringField(item, ['tool', 'name']) ?? 'Tool'
    return normalizeToolActivity(id, name, item.arguments ?? item.input, status)
  }
  if (itemType === 'file_change' || itemType === 'fileChange') {
    return agentActivity(id, 'tool', 'File change', undefined, status)
  }
  return undefined
}

async function callClaude(
  prompt: string,
  model?: string,
  effort?: LlmEffort,
  fastMode?: boolean,
  requestOptions: Pick<
    LlmRequestOptions,
    'signal' | 'onEvent' | 'cwd' | 'maxTurns' | 'tools'
  > = {},
): Promise<string> {
  throwIfAborted(requestOptions.signal)
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const abortController = new AbortController()
  const forwardAbort = () => abortController.abort(requestOptions.signal?.reason)
  requestOptions.signal?.addEventListener('abort', forwardAbort, { once: true })
  const options = {
    maxTurns: requestOptions.maxTurns ?? 1,
    includePartialMessages: true,
    abortController,
    ...(requestOptions.cwd ? { cwd: requestOptions.cwd } : {}),
    ...(requestOptions.tools
      ? {
          tools: requestOptions.tools,
          allowedTools: requestOptions.tools,
          permissionMode: 'dontAsk' as const,
        }
      : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode !== undefined ? { settings: { fastMode } } : {}),
  }
  let result: string | undefined
  let streamedText = false
  let errors: string[] = []
  const activityScope = ++llmCallSequence
  const thinkingBuffers = new Map<number, string>()
  const activitySignatures = new Map<string, string>()
  const emitActivity = (activity: AgentActivity) => {
    const signature = JSON.stringify(activity)
    if (activitySignatures.get(activity.id) === signature) return
    activitySignatures.set(activity.id, signature)
    requestOptions.onEvent?.({ type: 'activity', activity })
  }
  try {
    for await (const message of query({ prompt, options })) {
      throwIfAborted(requestOptions.signal)
      if (message.type === 'stream_event') {
        const event = message.event as {
          type?: string
          index?: number
          content_block?: {
            type?: string
            id?: string
            name?: string
            input?: unknown
          }
          delta?: { type?: string; text?: string; thinking?: string }
        }
        if (
          event.type === 'content_block_start'
          && event.content_block?.type === 'thinking'
        ) {
          const index = event.index ?? thinkingBuffers.size
          const id = `claude-${activityScope}-thinking-${index}`
          thinkingBuffers.set(index, '')
          emitActivity(agentActivity(id, 'thinking', 'Thinking', undefined, 'running'))
        }
        if (
          event.type === 'content_block_delta'
          && event.delta?.type === 'thinking_delta'
          && typeof event.delta.thinking === 'string'
        ) {
          const index = event.index ?? 0
          const current = thinkingBuffers.get(index) ?? ''
          thinkingBuffers.set(
            index,
            `${current}${event.delta.thinking}`.slice(0, MAX_THINKING_DETAIL_LENGTH),
          )
        }
        if (event.type === 'content_block_stop' && thinkingBuffers.has(event.index ?? 0)) {
          const index = event.index ?? 0
          const id = `claude-${activityScope}-thinking-${index}`
          emitActivity(agentActivity(
            id,
            'thinking',
            'Thinking',
            thinkingDetail(thinkingBuffers.get(index) ?? ''),
            'completed',
          ))
        }
        if (
          event.type === 'content_block_start'
          && event.content_block?.type === 'tool_use'
        ) {
          const activity = normalizeClaudeToolActivity(event.content_block)
          if (activity) emitActivity(activity)
        }
        if (
          event.type === 'content_block_delta'
          && event.delta?.type === 'text_delta'
          && typeof event.delta.text === 'string'
        ) {
          streamedText = true
          requestOptions.onEvent?.({
            type: 'assistant_delta',
            text: event.delta.text,
          })
        }
        continue
      }
      if (message.type === 'assistant') {
        const assistant = message as unknown as {
          message?: { content?: unknown[] }
        }
        for (const block of assistant.message?.content ?? []) {
          const activity = normalizeClaudeToolActivity(block)
          if (!activity) continue
          emitActivity(activity)
        }
        continue
      }
      if (message.type !== 'result') continue
      if (message.subtype === 'success') {
        result = message.structured_output === undefined
          ? message.result
          : JSON.stringify(message.structured_output)
      }
      else errors = message.errors
    }
  } catch (error) {
    if (requestOptions.signal?.aborted) throw new RunCancelledError()
    throw error
  } finally {
    requestOptions.signal?.removeEventListener('abort', forwardAbort)
  }
  if (result === undefined) {
    throw new Error(`Claude 未返回成功结果${errors.length ? `：${errors.join('; ')}` : ''}`)
  }
  if (!streamedText && result) {
    requestOptions.onEvent?.({ type: 'assistant_delta', text: result })
  }
  return result
}

function callCodex(
  prompt: string,
  model?: string,
  effort?: LlmEffort,
  fastMode?: boolean,
  requestOptions: Pick<
    LlmRequestOptions,
    'signal' | 'onEvent' | 'cwd' | 'outputSchemaPath'
  > = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      throwIfAborted(requestOptions.signal)
    } catch (error) {
      reject(error)
      return
    }
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      ...(requestOptions.cwd ? ['-C', requestOptions.cwd] : []),
      ...(requestOptions.outputSchemaPath
        ? ['--output-schema', requestOptions.outputSchemaPath]
        : []),
      ...(model ? ['-m', model] : []),
      ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      ...(fastMode !== undefined
        ? ['-c', `service_tier=${JSON.stringify(fastMode ? 'priority' : 'default')}`]
        : []),
      '-',
    ]
    const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdoutBuffer = ''
    let finalOutput = ''
    let streamedText = false
    let stderr = ''
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const activitySignatures = new Map<string, string>()

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      requestOptions.signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(finalOutput.trim())
    }

    const handleLine = (line: string) => {
      if (!line.trim()) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      const item = event.item && typeof event.item === 'object'
        ? event.item as Record<string, unknown>
        : undefined
      const activity = normalizeCodexActivity(event)
      if (activity && activitySignatures.get(activity.id) !== JSON.stringify(activity)) {
        activitySignatures.set(activity.id, JSON.stringify(activity))
        requestOptions.onEvent?.({ type: 'activity', activity })
      }
      if (item?.type !== 'agent_message') return
      if (event.type === 'item.updated') {
        const delta = item.delta && typeof item.delta === 'object'
          ? item.delta as Record<string, unknown>
          : undefined
        const text = typeof delta?.text === 'string'
          ? delta.text
          : typeof event.delta === 'string' ? event.delta : undefined
        if (text) {
          streamedText = true
          requestOptions.onEvent?.({ type: 'assistant_delta', text })
        }
      } else if (event.type === 'item.completed' && typeof item.text === 'string') {
        finalOutput = item.text
        if (!streamedText && finalOutput) {
          streamedText = true
          requestOptions.onEvent?.({ type: 'assistant_delta', text: finalOutput })
        }
      }
    }

    const abort = () => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        child.kill('SIGKILL')
      }, 2_000)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      let newline = stdoutBuffer.indexOf('\n')
      while (newline >= 0) {
        handleLine(stdoutBuffer.slice(0, newline))
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        newline = stdoutBuffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      handleLine(stdoutBuffer)
      if (requestOptions.signal?.aborted) {
        finish(new RunCancelledError())
      } else if (code !== 0) {
        finish(new Error(`codex 退出码 ${code ?? 'unknown'}：${stderr.trim()}`))
      } else if (!finalOutput.trim()) {
        finish(new Error('codex 未返回最终 assistant message'))
      } else {
        finish()
      }
    })
    requestOptions.signal?.addEventListener('abort', abort, { once: true })
    child.stdin.end(prompt)
  })
}

function extractJson(output: string): unknown {
  const trimmed = output.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidates = [
    trimmed,
    fenced,
    ...balancedJsonSlices(trimmed, '[', ']'),
    ...balancedJsonSlices(trimmed, '{', '}'),
  ].filter((value): value is string => Boolean(value))

  let lastError: unknown
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch (error) {
      lastError = error
    }
  }
  const message = lastError instanceof Error ? lastError.message : '未找到 JSON'
  throw new Error(`JSON 解析失败：${message}`)
}

function balancedJsonSlices(
  value: string,
  open: '[' | '{',
  close: ']' | '}',
): string[] {
  const slices: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === open) {
      if (depth === 0) start = index
      depth++
    } else if (character === close && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        slices.push(value.slice(start, index + 1))
        start = -1
      }
    }
  }
  return slices
}

export async function getStructuredResponse<T>(
  prompt: string,
  schema: z.ZodType<T>,
  provider: LlmProvider,
  model?: string,
  effort?: LlmEffort,
  options: LlmRequestOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 0
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error('maxRetries 必须是非负整数')
  const outputSchema = providerJsonSchema(schema)
  const providerPrompt = provider === 'claude'
    ? promptWithYamlSchema(prompt, outputSchema)
    : prompt
  let temporarySchemaDirectory: string | undefined
  let outputSchemaPath = options.outputSchemaPath
  if (provider === 'codex') {
    if (!outputSchemaPath) {
      temporarySchemaDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'memory-manager-schema-'),
      )
      outputSchemaPath = path.join(temporarySchemaDirectory, 'output.schema.json')
    } else {
      fs.mkdirSync(path.dirname(outputSchemaPath), { recursive: true })
    }
    fs.writeFileSync(outputSchemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }
  let lastError: unknown
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      throwIfAborted(options.signal)
      try {
        const rawOutput = provider === 'claude'
          ? await callClaude(
              providerPrompt,
              model,
              effort,
              options.fastMode,
              options,
            )
          : await callCodex(
              prompt,
              model,
              effort,
              options.fastMode,
              { ...options, outputSchemaPath },
            )
        const structuredOutput = provider === 'claude'
          ? extractClaudeStructuredOutput(rawOutput)
          : extractJson(rawOutput)
        return schema.parse(structuredOutput)
      } catch (error) {
        if (isRunCancelledError(error) || options.signal?.aborted) {
          throw new RunCancelledError()
        }
        lastError = error
        if (isDeterministicLlmFailure(error) || attempt >= maxRetries) throw error
        const message = error instanceof Error ? error.message : String(error)
        options.onEvent?.({ type: 'retry', message, attempt: attempt + 1 })
      }
    }
  } finally {
    if (temporarySchemaDirectory) {
      fs.rmSync(temporarySchemaDirectory, { recursive: true, force: true })
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`结构化输出在 ${maxRetries} 次重试后仍无效：${message}`)
}

function promptWithYamlSchema(
  prompt: string,
  outputSchema: Record<string, unknown>,
): string {
  return [
    prompt,
    '最终只输出语义符合以下 JSON Schema 的 YAML，根节点必须是数组，不要添加 Markdown fence 或其他说明。',
    'rule_text 和 reasoning 必须使用 YAML block scalar（|-），避免正文中的双引号破坏结构：',
    JSON.stringify(outputSchema),
  ].join('\n')
}

function extractClaudeStructuredOutput(output: string): unknown {
  const trimmed = output.trim()
  const fenced = trimmed.match(/```(?:yaml|yml)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidates = [fenced, trimmed].filter(
    (value): value is string => Boolean(value),
  )
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const parsed = parseYaml(candidate)
      if (parsed !== undefined) return parsed
    } catch (error) {
      lastError = error
    }
  }
  try {
    return extractJson(trimmed)
  } catch (jsonError) {
    const yamlMessage = lastError instanceof Error ? lastError.message : '未找到 YAML'
    const jsonMessage = jsonError instanceof Error ? jsonError.message : String(jsonError)
    throw new Error(`结构化输出解析失败：YAML ${yamlMessage}；${jsonMessage}`)
  }
}

function isDeterministicLlmFailure(error: unknown): boolean {
  if (error instanceof z.ZodError) return true
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return [
    'json 解析失败',
    'prompt is too long',
    'prompt too long',
    'context length',
    'max turns',
    'error_max_turns',
    'structured output',
    'error_max_structured_output_retries',
  ].some((pattern) => message.includes(pattern))
}

function providerJsonSchema<T>(schema: z.ZodType<T>): Record<string, unknown> {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>
  const { $schema: _metaSchema, ...portable } = generated
  return portable
}
