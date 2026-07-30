import { spawn } from 'node:child_process'
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
}

export type LlmStreamEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'retry'; message: string; attempt: number }

async function callClaude(
  prompt: string,
  model?: string,
  effort?: LlmEffort,
  fastMode?: boolean,
  requestOptions: Pick<LlmRequestOptions, 'signal' | 'onEvent'> = {},
): Promise<string> {
  throwIfAborted(requestOptions.signal)
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const abortController = new AbortController()
  const forwardAbort = () => abortController.abort(requestOptions.signal?.reason)
  requestOptions.signal?.addEventListener('abort', forwardAbort, { once: true })
  const options = {
    maxTurns: 1,
    includePartialMessages: true,
    abortController,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode !== undefined ? { settings: { fastMode } } : {}),
  }
  let result: string | undefined
  let streamedText = false
  let errors: string[] = []
  try {
    for await (const message of query({ prompt, options })) {
      throwIfAborted(requestOptions.signal)
      if (message.type === 'stream_event') {
        const event = message.event as {
          type?: string
          delta?: { type?: string; text?: string }
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
      if (message.type !== 'result') continue
      if (message.subtype === 'success') result = message.result
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
  requestOptions: Pick<LlmRequestOptions, 'signal' | 'onEvent'> = {},
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
  const candidates = [trimmed, fenced].filter((value): value is string => Boolean(value))
  const arrayStart = trimmed.indexOf('[')
  const arrayEnd = trimmed.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(trimmed.slice(arrayStart, arrayEnd + 1))
  const objectStart = trimmed.indexOf('{')
  const objectEnd = trimmed.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(trimmed.slice(objectStart, objectEnd + 1))

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

export async function getStructuredResponse<T>(
  prompt: string,
  schema: z.ZodType<T>,
  provider: LlmProvider,
  model?: string,
  effort?: LlmEffort,
  options: LlmRequestOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error('maxRetries 必须是非负整数')
  const schemaPrompt = `${prompt}\n\n只输出符合以下 JSON Schema 的 JSON，不要输出解释或 markdown：\nJSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`
  let retryContext = ''
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    throwIfAborted(options.signal)
    const request = `${schemaPrompt}${retryContext}`
    let rawOutput = ''
    try {
      rawOutput = provider === 'claude'
        ? await callClaude(request, model, effort, options.fastMode, options)
        : await callCodex(request, model, effort, options.fastMode, options)
      return schema.parse(extractJson(rawOutput))
    } catch (error) {
      if (isRunCancelledError(error) || options.signal?.aborted) {
        throw new RunCancelledError()
      }
      lastError = error
      const message = error instanceof z.ZodError
        ? JSON.stringify(error.issues)
        : error instanceof Error ? error.message : String(error)
      const outputSnippet = rawOutput.length > 0
        ? `\n你上次的原始输出前 300 字符：\n${rawOutput.slice(0, 300)}`
        : ''
      retryContext = `\n\n上次输出无效：${message}${outputSnippet}\n请只输出合法 JSON 数组，不要有任何其他文字。`
      if (attempt < maxRetries) {
        options.onEvent?.({ type: 'retry', message, attempt: attempt + 1 })
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`结构化输出在 ${maxRetries} 次重试后仍无效：${message}`)
}
