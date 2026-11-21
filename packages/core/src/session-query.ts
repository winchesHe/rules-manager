import { parse } from '@babel/parser'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { z } from 'zod'
import {
  readSessionEventSources,
  type SessionEvent,
  type SessionEventOrigin,
  type SessionEventReadResult,
} from './session-events.js'
import type { AgentName, SessionStatus } from './types.js'
import { resolveWorkspace } from './workspace.js'

export const SESSION_QUERY_VERSION = 2 as const
export const SESSION_QUERY_LEGACY_VERSION = 1 as const
export const TOOL_REGISTRY_VERSION = 2 as const

const agentSchema = z.enum(['claude', 'codex', 'copilot', 'cursor', 'gemini', 'grok', 't3', 'antigravity', 'opencode', 'pi'])
const statusSchema = z.enum(['new', 'updated', 'unchanged', 'missing', 'error'])
const keywordFieldSchema = z.enum([
  'user',
  'assistant',
  'tool_call_input',
  'tool_result_output',
  'title',
])
const mentionFieldSchema = z.enum([
  'message',
  'tool_call_input',
  'tool_result_output',
  'title',
])
const originSchema = z.enum([
  'human_user',
  'assistant_output',
  'tool_runtime',
  'developer_instruction',
  'host_context',
  'skill_instruction',
  'internal_job',
  'historical_forward',
  'unknown',
])
const provenanceSchema = z.enum(['direct', 'nested-ast', 'capability-derived'])
const legacyProvenanceSchema = z.enum(['direct', 'nested', 'capability-derived'])

const timeSchema = z.object({
  lastDays: z.number().int().positive().max(3650).optional(),
  since: z.string().refine(
    (value) => !Number.isNaN(Date.parse(value)),
    'since 必须是 ISO 8601 时间',
  ).optional(),
  until: z.string().refine(
    (value) => !Number.isNaN(Date.parse(value)),
    'until 必须是 ISO 8601 时间',
  ).optional(),
}).strict().superRefine((value, context) => {
  if (value.lastDays !== undefined && (value.since !== undefined || value.until !== undefined)) {
    context.addIssue({ code: 'custom', message: 'lastDays 不能和 since/until 混用' })
  }
  if (
    value.since !== undefined
    && value.until !== undefined
    && Date.parse(value.since) > Date.parse(value.until)
  ) {
    context.addIssue({ code: 'custom', message: 'since 不能晚于 until' })
  }
})

const scopeV1Schema = z.object({
  agents: z.array(agentSchema).min(1).optional(),
  projects: z.array(z.string().trim().min(1).max(200)).min(1).optional(),
  statuses: z.array(statusSchema).min(1).optional(),
}).strict()

const scopeV2Schema = scopeV1Schema.extend({
  includeInternal: z.boolean().default(false),
}).strict()

const legacyToolPredicateSchema = z.object({
  families: z.array(z.string().trim().min(1).max(100)).min(1).optional(),
  names: z.array(z.string().trim().min(1).max(200)).min(1).optional(),
  operations: z.array(z.string().trim().min(1).max(100)).min(1).optional(),
  provenance: z.array(legacyProvenanceSchema).min(1).optional(),
}).strict().refine(
  (value) => value.families || value.names || value.operations,
  'tool 至少需要 families、names 或 operations 之一',
)

const usedToolPredicateSchema = z.object({
  families: z.array(z.string().trim().min(1).max(100)).min(1).optional(),
  names: z.array(z.string().trim().min(1).max(200)).min(1).optional(),
  operations: z.array(z.string().trim().min(1).max(100)).min(1).optional(),
  provenance: z.array(provenanceSchema).min(1).optional(),
}).strict().refine(
  (value) => value.families || value.names || value.operations,
  'usedTool 至少需要 families、names 或 operations 之一',
)

const keywordPredicateSchema = z.object({
  terms: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
  mode: z.enum(['any', 'all']).default('any'),
  fields: z.array(keywordFieldSchema).min(1).optional(),
  caseSensitive: z.boolean().default(false),
}).strict()

const mentionsPredicateSchema = z.object({
  terms: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
  mode: z.enum(['any', 'all']).default('any'),
  fields: z.array(mentionFieldSchema).min(1).optional(),
  origins: z.array(originSchema).min(1).optional(),
  caseSensitive: z.boolean().default(false),
}).strict()

export type ToolProvenance = z.infer<typeof provenanceSchema>
export type LegacyToolProvenance = z.infer<typeof legacyProvenanceSchema>
export type KeywordField = z.infer<typeof keywordFieldSchema>
export type MentionField = z.infer<typeof mentionFieldSchema>
export type ToolPredicate = z.infer<typeof usedToolPredicateSchema>
export type LegacyToolPredicate = z.infer<typeof legacyToolPredicateSchema>
export type KeywordPredicate = z.infer<typeof keywordPredicateSchema>
export type MentionsPredicate = z.infer<typeof mentionsPredicateSchema>

export type SessionPredicateV1 =
  | { all: SessionPredicateV1[] }
  | { any: SessionPredicateV1[] }
  | { not: SessionPredicateV1 }
  | { tool: LegacyToolPredicate }
  | { keyword: KeywordPredicate }

export type SessionPredicateV2 =
  | { all: SessionPredicateV2[] }
  | { any: SessionPredicateV2[] }
  | { not: SessionPredicateV2 }
  | { usedTool: ToolPredicate }
  | { mentions: MentionsPredicate }

export type SessionPredicate = SessionPredicateV1 | SessionPredicateV2

const predicateV1Schema: z.ZodType<SessionPredicateV1> = z.lazy(() => z.union([
  z.object({ all: z.array(predicateV1Schema).min(1) }).strict(),
  z.object({ any: z.array(predicateV1Schema).min(1) }).strict(),
  z.object({ not: predicateV1Schema }).strict(),
  z.object({ tool: legacyToolPredicateSchema }).strict(),
  z.object({ keyword: keywordPredicateSchema }).strict(),
]))

const predicateV2Schema: z.ZodType<SessionPredicateV2> = z.lazy(() => z.union([
  z.object({ all: z.array(predicateV2Schema).min(1) }).strict(),
  z.object({ any: z.array(predicateV2Schema).min(1) }).strict(),
  z.object({ not: predicateV2Schema }).strict(),
  z.object({ usedTool: usedToolPredicateSchema }).strict(),
  z.object({ mentions: mentionsPredicateSchema }).strict(),
]))

const queryV1Schema = z.object({
  version: z.literal(SESSION_QUERY_LEGACY_VERSION),
  time: timeSchema.optional(),
  scope: scopeV1Schema.optional(),
  where: predicateV1Schema.optional(),
}).strict()

const queryV2Schema = z.object({
  version: z.literal(SESSION_QUERY_VERSION),
  time: timeSchema.optional(),
  scope: scopeV2Schema.optional(),
  where: predicateV2Schema.optional(),
}).strict()

const querySchema = z.discriminatedUnion('version', [queryV1Schema, queryV2Schema])

export type SessionQueryV1 = z.infer<typeof queryV1Schema>
export type SessionQueryV2 = z.infer<typeof queryV2Schema>
export type SessionQuery = SessionQueryV1 | SessionQueryV2

export interface ToolSignal {
  family?: string
  toolName: string
  operation?: string
  provenance: ToolProvenance
  eventIndex: number
  sourceLocator: string
  codeRange?: { start: number; end: number }
}

export interface ToolParseUnknown {
  eventIndex: number
  sourceLocator: string
  outerToolName: string
  suspectedFamilies: string[]
  errorMessage: string
}

export interface MatchProof {
  kind:
    | 'all'
    | 'tool'
    | 'tool_usage'
    | 'keyword'
    | 'mention'
    | 'not'
    | 'excluded_internal'
  eventIndex?: number
  sourceLocator?: string
  contentHash?: string
  term?: string
  field?: KeywordField | MentionField
  origin?: SessionEventOrigin
  family?: string
  toolName?: string
  operation?: string
  provenance?: ToolProvenance | LegacyToolProvenance
  codeRange?: { start: number; end: number }
  predicateHash?: string
}

export interface SessionSelectionOutcome {
  sessionId: string
  agent: AgentName
  projectSlug: string
  updatedAt: string
  status: SessionStatus
  selectionStatus: 'matched' | 'not_matched' | 'unknown'
  eventCount: number
  proofs: MatchProof[]
  sourceRevision?: SessionEventReadResult['sourceRevision']
  errorCode?: string
  errorMessage?: string
}

export interface SelectionCoverage {
  candidates: number
  inspected: number
  matched: number
  notMatched: number
  unknown: number
  unknownSource: number
  unknownOrigin: number
  unknownToolParse: number
  changedDuringRun: number
}

export interface SessionQueryExecution {
  query: SessionQuery
  queryHash: string
  evaluatedAt: string
  coverage: SelectionCoverage
  outcomes: SessionSelectionOutcome[]
  matchedSources: SessionEventReadResult[]
}

export interface RunSessionQueryOptions {
  homeDir?: string
  now?: Date
  signal?: AbortSignal
  retainMatchedSources?: boolean
  onMatchedSource?: (
    source: SessionEventReadResult,
    outcome: SessionSelectionOutcome,
  ) => void | Promise<void>
}

interface CandidateRow {
  id: string
  agent: AgentName
  slug: string
  updated_at: string
  status: SessionStatus
}

export interface PredicateResult {
  status: 'matched' | 'not_matched' | 'unknown'
  matched: boolean
  proofs: MatchProof[]
  unknownCode?: 'QUERY_ORIGIN_UNKNOWN' | 'QUERY_TOOL_PARSE_UNKNOWN'
  unknownMessage?: string
}

interface ToolSignalAnalysis {
  signals: ToolSignal[]
  unknowns: ToolParseUnknown[]
}

type AstRecord = Record<string, unknown> & {
  type?: string
  start?: number
  end?: number
}

const DEFAULT_KEYWORD_FIELDS: KeywordField[] = [
  'user',
  'assistant',
  'tool_call_input',
  'tool_result_output',
  'title',
]
const DEFAULT_MENTION_FIELDS: MentionField[] = ['message']
const DEFAULT_MENTION_ORIGINS: SessionEventOrigin[] = ['human_user', 'assistant_output']
const MAX_PREDICATE_DEPTH = 8
const SUSPECTED_NESTED_TOOL_PATTERN = /tools\s*(?:\.|\[\s*['"])(?:mcp__)?(?:computer[_-]use|chrome)(?:__|['"])|\bsky\s*\.\s*(?:click|drag|get_app_state|list_apps|perform_secondary_action|press_key|scroll|select_text|set_value|type_text)\s*\(|\b(?:globalThis\s*\.\s*)?chrome\s*\.\s*[A-Za-z_$]|agent\s*\.\s*browsers\s*\.\s*get\s*\(\s*['"]chrome['"]/i
const COMPUTER_SKY_OPERATIONS = new Set([
  'click',
  'drag',
  'get_app_state',
  'list_apps',
  'perform_secondary_action',
  'press_key',
  'scroll',
  'select_text',
  'set_value',
  'type_text',
])

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function assertPredicateDepth(predicate: SessionPredicate, depth = 1): void {
  if (depth > MAX_PREDICATE_DEPTH) {
    throw new Error(`where 递归深度不能超过 ${MAX_PREDICATE_DEPTH}`)
  }
  if ('all' in predicate) {
    predicate.all.forEach((child) => assertPredicateDepth(child, depth + 1))
  } else if ('any' in predicate) {
    predicate.any.forEach((child) => assertPredicateDepth(child, depth + 1))
  } else if ('not' in predicate) {
    assertPredicateDepth(predicate.not, depth + 1)
  }
}

export function parseSessionQuery(value: unknown): SessionQuery {
  const parsed = querySchema.parse(value)
  if (parsed.where) assertPredicateDepth(parsed.where)
  return parsed
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_')
}

function directToolFamily(name: string): string | undefined {
  const normalized = normalizeToolName(name)
  if (
    normalized === 'computer_use'
    || normalized === 'computer_use_legacy'
    || normalized.startsWith('mcp__computer_use__')
    || normalized.startsWith('mcp__computer_use_legacy__')
  ) return 'computer-use'
  if (
    normalized === 'chrome_use'
    || normalized === 'control_chrome'
    || normalized.startsWith('mcp__chrome__')
  ) return 'chrome-use'
  return undefined
}

function capabilityToolFamily(name: string): string | undefined {
  const normalized = normalizeToolName(name)
  if (normalized === 'computer') return 'computer-use'
  if (normalized === 'chrome') return 'chrome-use'
  return undefined
}

function contentOperation(content: unknown): string | undefined {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return undefined
  const record = content as Record<string, unknown>
  for (const key of ['action', 'operation', 'command']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function nameOperation(name: string): string | undefined {
  const parts = name.split('__')
  return parts.length > 1 ? parts.at(-1) : undefined
}

function signalFor(
  event: SessionEvent,
  toolName: string,
  provenance: ToolProvenance,
  codeRange?: ToolSignal['codeRange'],
): ToolSignal {
  const family = directToolFamily(toolName) ?? capabilityToolFamily(toolName)
  const operation = provenance === 'nested-ast'
    ? nameOperation(toolName)
    : contentOperation(event.content) ?? nameOperation(toolName)
  return {
    ...(family ? { family } : {}),
    toolName,
    ...(operation ? { operation } : {}),
    provenance,
    eventIndex: event.index,
    sourceLocator: event.sourceLocator,
    ...(codeRange ? { codeRange } : {}),
  }
}

function asAstRecord(value: unknown): AstRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as AstRecord
    : undefined
}

function staticMemberPath(value: unknown): string[] | undefined {
  const node = asAstRecord(value)
  if (!node) return undefined
  if (node.type === 'Identifier' && typeof node.name === 'string') return [node.name]
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return undefined
  const objectPath = staticMemberPath(node.object)
  if (!objectPath) return undefined
  const property = asAstRecord(node.property)
  if (!property) return undefined
  if (node.computed === true) {
    if (property.type !== 'StringLiteral' || typeof property.value !== 'string') return undefined
    return [...objectPath, property.value]
  }
  return property.type === 'Identifier' && typeof property.name === 'string'
    ? [...objectPath, property.name]
    : undefined
}

function executableJavascript(event: SessionEvent): string | undefined {
  if (!event.toolName) return undefined
  const outerName = normalizeToolName(event.toolName)
  if (!isJavascriptContainerName(outerName)) return undefined
  if (typeof event.content === 'string') return event.content
  if (!event.content || typeof event.content !== 'object' || Array.isArray(event.content)) {
    return undefined
  }
  const record = event.content as Record<string, unknown>
  for (const field of ['code', 'script', 'source']) {
    if (typeof record[field] === 'string') return record[field]
  }
  return undefined
}

function isJavascriptContainerName(name: string): boolean {
  const normalized = normalizeToolName(name)
  return normalized === 'exec'
    || normalized === 'node_repl'
    || normalized.endsWith('__js')
    || normalized.endsWith('__node_repl')
}

function isNodeReplName(name: string): boolean {
  const normalized = normalizeToolName(name)
  return normalized === 'node_repl'
    || normalized.endsWith('__js')
    || normalized.endsWith('__node_repl')
}

function staticStringValue(value: unknown): string | undefined {
  const node = asAstRecord(value)
  if (!node) return undefined
  if (node.type === 'StringLiteral' && typeof node.value === 'string') return node.value
  if (node.type !== 'TemplateLiteral' || !Array.isArray(node.expressions) || node.expressions.length > 0) {
    return undefined
  }
  if (!Array.isArray(node.quasis)) return undefined
  return node.quasis.map((quasi) => {
    const record = asAstRecord(quasi)
    const valueRecord = asAstRecord(record?.value)
    return typeof valueRecord?.cooked === 'string'
      ? valueRecord.cooked
      : typeof valueRecord?.raw === 'string'
        ? valueRecord.raw
        : ''
  }).join('')
}

function objectPropertyName(value: unknown): string | undefined {
  const node = asAstRecord(value)
  if (!node) return undefined
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name
  if (node.type === 'StringLiteral' && typeof node.value === 'string') return node.value
  return undefined
}

function nestedJavascriptArgument(call: AstRecord): string | undefined {
  if (!Array.isArray(call.arguments)) return undefined
  const first = asAstRecord(call.arguments[0])
  if (!first || first.type !== 'ObjectExpression' || !Array.isArray(first.properties)) {
    return undefined
  }
  for (const propertyValue of first.properties) {
    const property = asAstRecord(propertyValue)
    if (!property || property.type !== 'ObjectProperty') continue
    if (objectPropertyName(property.key) !== 'code') continue
    return staticStringValue(property.value)
  }
  return undefined
}

function staticFirstCallArgument(call: AstRecord): string | undefined {
  return Array.isArray(call.arguments) ? staticStringValue(call.arguments[0]) : undefined
}

function suspectedFamilies(code: string): string[] {
  const families: string[] = []
  if (/computer[_-]use/i.test(code)) families.push('computer-use')
  if (/\bsky\s*\./i.test(code) || /@oai\/sky/i.test(code)) families.push('computer-use')
  if (
    /(?:mcp__)?chrome(?:__|['"\]])/i.test(code)
    || /\b(?:globalThis\s*\.\s*)?chrome\s*\./i.test(code)
  ) families.push('chrome-use')
  if (/agent\s*\.\s*browsers\s*\.\s*get\s*\(\s*['"]chrome['"]/i.test(code)) {
    families.push('chrome-use')
  }
  return families
}

function nestedSignals(
  event: SessionEvent,
  code: string,
  capabilityRuntime = isNodeReplName(event.toolName ?? ''),
  depth = 0,
): ToolSignalAnalysis {
  if (depth > 3) return { signals: [], unknowns: [] }
  let ast: unknown
  try {
    ast = parse(code, {
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      plugins: ['typescript', 'topLevelAwait'],
    })
  } catch (error) {
    if (!SUSPECTED_NESTED_TOOL_PATTERN.test(code)) return { signals: [], unknowns: [] }
    return {
      signals: [],
      unknowns: [{
        eventIndex: event.index,
        sourceLocator: event.sourceLocator,
        outerToolName: event.toolName ?? 'unknown',
        suspectedFamilies: suspectedFamilies(code),
        errorMessage: error instanceof Error ? error.message : String(error),
      }],
    }
  }

  const signals: ToolSignal[] = []
  const unknowns: ToolParseUnknown[] = []
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const node = asAstRecord(value)
    if (!node) return
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const path = staticMemberPath(node.callee)
      if (path?.[0] === 'tools' && path[1]) {
        const nestedName = path[1]
        if (directToolFamily(nestedName) || capabilityToolFamily(nestedName)) {
          signals.push(signalFor(
            event,
            nestedName,
            'nested-ast',
            typeof node.start === 'number' && typeof node.end === 'number'
              ? { start: node.start, end: node.end }
              : undefined,
          ))
        }
        if (isNodeReplName(nestedName)) {
          const nestedCode = nestedJavascriptArgument(node)
          if (nestedCode !== undefined) {
            const nested = nestedSignals(event, nestedCode, true, depth + 1)
            signals.push(...nested.signals)
            unknowns.push(...nested.unknowns)
          }
        }
      }
      if (capabilityRuntime && path) {
        const skyOffset = path[0] === 'sky' ? 1 : path[0] === 'globalThis' && path[1] === 'sky' ? 2 : -1
        const skyOperation = skyOffset >= 0 ? path[skyOffset] : undefined
        if (skyOperation && COMPUTER_SKY_OPERATIONS.has(skyOperation)) {
          signals.push({
            family: 'computer-use',
            toolName: `@oai/sky.${skyOperation}`,
            operation: skyOperation,
            provenance: 'capability-derived',
            eventIndex: event.index,
            sourceLocator: event.sourceLocator,
            ...(typeof node.start === 'number' && typeof node.end === 'number'
              ? { codeRange: { start: node.start, end: node.end } }
              : {}),
          })
        }
        const selectsChrome = path.join('.') === 'agent.browsers.get'
          && staticFirstCallArgument(node) === 'chrome'
        const chromeOffset = path[0] === 'chrome'
          ? 1
          : path[0] === 'globalThis' && path[1] === 'chrome'
            ? 2
            : -1
        const chromeOperation = chromeOffset >= 0 ? path.slice(chromeOffset).join('.') : undefined
        if (selectsChrome || chromeOperation) {
          const operation = selectsChrome ? 'select' : chromeOperation!
          signals.push({
            family: 'chrome-use',
            toolName: `browser-client.chrome.${operation}`,
            operation,
            provenance: 'capability-derived',
            eventIndex: event.index,
            sourceLocator: event.sourceLocator,
            ...(typeof node.start === 'number' && typeof node.end === 'number'
              ? { codeRange: { start: node.start, end: node.end } }
              : {}),
          })
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments', 'tokens', 'errors'].includes(key)) continue
      visit(child)
    }
  }
  visit(ast)
  return { signals, unknowns }
}

export function analyzeToolSignals(events: SessionEvent[]): ToolSignalAnalysis {
  const signals: ToolSignal[] = []
  const unknowns: ToolParseUnknown[] = []
  for (const event of events) {
    if (event.kind !== 'tool_call' || !event.toolName) continue
    const directFamily = directToolFamily(event.toolName)
    const capabilityFamily = capabilityToolFamily(event.toolName)
    if (directFamily) signals.push(signalFor(event, event.toolName, 'direct'))
    else if (capabilityFamily) signals.push(signalFor(event, event.toolName, 'capability-derived'))
    else signals.push(signalFor(event, event.toolName, 'direct'))

    const code = executableJavascript(event)
    if (!code) continue
    const nested = nestedSignals(event, code)
    signals.push(...nested.signals)
    unknowns.push(...nested.unknowns)
  }
  return { signals, unknowns }
}

export function extractToolSignals(events: SessionEvent[]): ToolSignal[] {
  return analyzeToolSignals(events).signals
}

function searchableContent(event: SessionEvent, field: KeywordField): unknown | undefined {
  if (field === 'user' && event.kind === 'message' && event.role === 'user') return event.content
  if (field === 'assistant' && event.kind === 'message' && event.role === 'assistant') {
    return event.content
  }
  if (field === 'tool_call_input' && event.kind === 'tool_call') return event.content
  if (field === 'tool_result_output' && event.kind === 'tool_result') return event.content
  if (field === 'title' && event.kind === 'metadata') {
    const record = event.content && typeof event.content === 'object' && !Array.isArray(event.content)
      ? event.content as Record<string, unknown>
      : undefined
    return typeof record?.title === 'string' ? record.title : undefined
  }
  return undefined
}

function mentionContent(event: SessionEvent, field: MentionField): unknown | undefined {
  if (field === 'message' && event.kind === 'message') return event.content
  if (field === 'tool_call_input' && event.kind === 'tool_call') return event.content
  if (field === 'tool_result_output' && event.kind === 'tool_result') return event.content
  if (field === 'title' && event.kind === 'metadata') {
    const record = event.content && typeof event.content === 'object' && !Array.isArray(event.content)
      ? event.content as Record<string, unknown>
      : undefined
    return typeof record?.title === 'string' ? record.title : undefined
  }
  return undefined
}

function asSearchText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function predicateResult(
  status: PredicateResult['status'],
  proofs: MatchProof[] = [],
  details: Pick<PredicateResult, 'unknownCode' | 'unknownMessage'> = {},
): PredicateResult {
  return { status, matched: status === 'matched', proofs, ...details }
}

function evaluateKeyword(
  predicate: KeywordPredicate,
  events: SessionEvent[],
): PredicateResult {
  const fields = predicate.fields ?? DEFAULT_KEYWORD_FIELDS
  const terms = predicate.caseSensitive
    ? predicate.terms
    : predicate.terms.map((term) => term.toLocaleLowerCase())
  const proofsByTerm = new Map<string, MatchProof[]>()
  for (const originalTerm of predicate.terms) proofsByTerm.set(originalTerm, [])

  for (const event of events) {
    for (const field of fields) {
      const content = searchableContent(event, field)
      if (content === undefined) continue
      const rawText = asSearchText(content)
      const text = predicate.caseSensitive ? rawText : rawText.toLocaleLowerCase()
      for (const [index, term] of terms.entries()) {
        if (!text.includes(term)) continue
        const originalTerm = predicate.terms[index]
        proofsByTerm.get(originalTerm)!.push({
          kind: 'keyword',
          eventIndex: event.index,
          sourceLocator: event.sourceLocator,
          contentHash: stableHash(content),
          term: originalTerm,
          field,
          origin: event.origin,
        })
      }
    }
  }

  const matchedTerms = predicate.terms.filter((term) => proofsByTerm.get(term)!.length > 0)
  const matched = predicate.mode === 'all'
    ? matchedTerms.length === predicate.terms.length
    : matchedTerms.length > 0
  return predicateResult(
    matched ? 'matched' : 'not_matched',
    matched ? matchedTerms.map((term) => proofsByTerm.get(term)![0]) : [],
  )
}

function evaluateMentions(
  predicate: MentionsPredicate,
  events: SessionEvent[],
): PredicateResult {
  const fields = predicate.fields ?? DEFAULT_MENTION_FIELDS
  const origins = predicate.origins ?? DEFAULT_MENTION_ORIGINS
  const terms = predicate.caseSensitive
    ? predicate.terms
    : predicate.terms.map((term) => term.toLocaleLowerCase())
  const proofsByTerm = new Map<string, MatchProof[]>()
  const unknownTerms = new Set<string>()
  predicate.terms.forEach((term) => proofsByTerm.set(term, []))

  for (const event of events) {
    for (const field of fields) {
      const content = mentionContent(event, field)
      if (content === undefined) continue
      const messageField = field === 'message'
      const originAllowed = origins.includes(event.origin)
      if (messageField && !originAllowed && event.origin !== 'unknown') continue
      const rawText = asSearchText(content)
      const text = predicate.caseSensitive ? rawText : rawText.toLocaleLowerCase()
      for (const [index, term] of terms.entries()) {
        if (!text.includes(term)) continue
        const originalTerm = predicate.terms[index]
        if (messageField && event.origin === 'unknown' && !originAllowed) {
          unknownTerms.add(originalTerm)
          continue
        }
        proofsByTerm.get(originalTerm)!.push({
          kind: 'mention',
          eventIndex: event.index,
          sourceLocator: event.sourceLocator,
          contentHash: stableHash(content),
          term: originalTerm,
          field,
          origin: event.origin,
        })
      }
    }
  }

  const matchedTerms = predicate.terms.filter((term) => proofsByTerm.get(term)!.length > 0)
  if (predicate.mode === 'any') {
    if (matchedTerms.length > 0) {
      return predicateResult('matched', matchedTerms.map((term) => proofsByTerm.get(term)![0]))
    }
    if (unknownTerms.size > 0) {
      return predicateResult('unknown', [], {
        unknownCode: 'QUERY_ORIGIN_UNKNOWN',
        unknownMessage: `关键词只出现在 unknown origin：${[...unknownTerms].join(', ')}`,
      })
    }
    return predicateResult('not_matched')
  }

  if (matchedTerms.length === predicate.terms.length) {
    return predicateResult('matched', matchedTerms.map((term) => proofsByTerm.get(term)![0]))
  }
  const missingTerms = predicate.terms.filter((term) => !proofsByTerm.get(term)!.length)
  if (missingTerms.every((term) => unknownTerms.has(term))) {
    return predicateResult('unknown', [], {
      unknownCode: 'QUERY_ORIGIN_UNKNOWN',
      unknownMessage: `必需关键词的 origin 无法确认：${missingTerms.join(', ')}`,
    })
  }
  return predicateResult('not_matched')
}

function includesNormalized(values: string[] | undefined, target: string | undefined): boolean {
  if (!values) return true
  if (!target) return false
  const normalizedTarget = normalizeToolName(target)
  return values.some((value) => normalizeToolName(value) === normalizedTarget)
}

function matchingToolSignals(
  predicate: ToolPredicate | LegacyToolPredicate,
  events: SessionEvent[],
): { signals: ToolSignal[]; unknowns: ToolParseUnknown[] } {
  const analysis = analyzeToolSignals(events)
  const requestedProvenance = predicate.provenance?.map((value) => (
    value === 'nested' ? 'nested-ast' : value
  ))
  const signals = analysis.signals.filter((signal) => (
    includesNormalized(predicate.families, signal.family)
    && includesNormalized(predicate.names, signal.toolName)
    && includesNormalized(predicate.operations, signal.operation)
    && (!requestedProvenance || requestedProvenance.includes(signal.provenance))
  ))
  const unknowns = analysis.unknowns.filter((unknown) => (
    !predicate.families
    || predicate.families.some((family) => unknown.suspectedFamilies.includes(family))
  ))
  const seen = new Set<string>()
  return {
    signals: signals.filter((signal) => {
      const key = [
        signal.family,
        signal.toolName,
        signal.operation,
        signal.provenance,
        signal.eventIndex,
      ].join('\0')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
    unknowns,
  }
}

function evaluateTool(
  predicate: ToolPredicate | LegacyToolPredicate,
  events: SessionEvent[],
  proofKind: 'tool' | 'tool_usage',
): PredicateResult {
  const { signals, unknowns } = matchingToolSignals(predicate, events)
  if (signals.length > 0) {
    return predicateResult('matched', signals.map((signal) => ({
      kind: proofKind,
      eventIndex: signal.eventIndex,
      sourceLocator: signal.sourceLocator,
      family: signal.family,
      toolName: signal.toolName,
      operation: signal.operation,
      provenance: proofKind === 'tool' && signal.provenance === 'nested-ast'
        ? 'nested'
        : signal.provenance,
      codeRange: signal.codeRange,
    })))
  }
  if (unknowns.length > 0) {
    return predicateResult('unknown', [], {
      unknownCode: 'QUERY_TOOL_PARSE_UNKNOWN',
      unknownMessage: `疑似嵌套工具调用无法解析：event ${unknowns[0].eventIndex}`,
    })
  }
  return predicateResult('not_matched')
}

function uniqueProofs(proofs: MatchProof[]): MatchProof[] {
  const seen = new Set<string>()
  return proofs.filter((proof) => {
    const key = JSON.stringify(proof)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function evaluateSessionPredicate(
  predicate: SessionPredicate,
  events: SessionEvent[],
): PredicateResult {
  if ('tool' in predicate) return evaluateTool(predicate.tool, events, 'tool')
  if ('usedTool' in predicate) return evaluateTool(predicate.usedTool, events, 'tool_usage')
  if ('keyword' in predicate) return evaluateKeyword(predicate.keyword, events)
  if ('mentions' in predicate) return evaluateMentions(predicate.mentions, events)
  if ('not' in predicate) {
    const child = evaluateSessionPredicate(predicate.not, events)
    if (child.status === 'unknown') return child
    return child.status === 'matched'
      ? predicateResult('not_matched')
      : predicateResult('matched', [{ kind: 'not', predicateHash: stableHash(predicate.not) }])
  }

  const children = ('all' in predicate ? predicate.all : predicate.any)
    .map((child) => evaluateSessionPredicate(child, events))
  if ('all' in predicate) {
    if (children.some((child) => child.status === 'not_matched')) {
      return predicateResult('not_matched')
    }
    const unknown = children.find((child) => child.status === 'unknown')
    if (unknown) return unknown
    return predicateResult(
      'matched',
      uniqueProofs(children.flatMap((child) => child.proofs)),
    )
  }
  const matched = children.filter((child) => child.status === 'matched')
  if (matched.length > 0) {
    return predicateResult('matched', uniqueProofs(matched.flatMap((child) => child.proofs)))
  }
  const unknown = children.find((child) => child.status === 'unknown')
  return unknown ?? predicateResult('not_matched')
}

function queryWindow(query: SessionQuery, now: Date): { since?: string; until?: string } {
  if (query.time?.lastDays !== undefined) {
    return {
      since: new Date(now.getTime() - query.time.lastDays * 24 * 60 * 60 * 1000).toISOString(),
      until: now.toISOString(),
    }
  }
  return {
    ...(query.time?.since ? { since: new Date(query.time.since).toISOString() } : {}),
    ...(query.time?.until ? { until: new Date(query.time.until).toISOString() } : {}),
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function loadCandidates(
  query: SessionQuery,
  now: Date,
  homeDir?: string,
): CandidateRow[] {
  const db = new Database(resolveWorkspace(homeDir).dbPath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const clauses: string[] = []
    const parameters: unknown[] = []
    const window = queryWindow(query, now)
    if (window.since) {
      clauses.push('updated_at >= ?')
      parameters.push(window.since)
    }
    if (window.until) {
      clauses.push('updated_at <= ?')
      parameters.push(window.until)
    }
    const hasBindings = Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_bindings'",
    ).get())
    if (query.scope?.agents) {
      const slots = placeholders(query.scope.agents.length)
      if (hasBindings) {
        clauses.push(`(agent IN (${slots}) OR (agent = 't3' AND id IN
          (SELECT host_id FROM session_bindings WHERE provider IN (${slots}))))`)
        parameters.push(...query.scope.agents)
      } else clauses.push(`agent IN (${slots})`)
      parameters.push(...query.scope.agents)
    }
    if (query.scope?.projects) {
      clauses.push(`slug IN (${placeholders(query.scope.projects.length)})`)
      parameters.push(...query.scope.projects)
    }
    if (query.scope?.statuses) {
      clauses.push(`status IN (${placeholders(query.scope.statuses.length)})`)
      parameters.push(...query.scope.statuses)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    return db.prepare(`
      WITH candidates AS (SELECT id, agent, slug, updated_at, status FROM sessions ${where})
      SELECT * FROM candidates c
      ${hasBindings ? `WHERE NOT EXISTS (
        SELECT 1 FROM session_bindings b JOIN candidates host ON host.id = b.host_id
        WHERE b.provider = c.agent AND b.native_id = c.id AND host.agent = 't3'
          AND host.status NOT IN ('error','missing')
      )` : ''}
      ORDER BY updated_at DESC, id ASC
    `).all(...parameters) as CandidateRow[]
  } finally {
    db.close()
  }
}

function isInternalSession(events: SessionEvent[]): boolean {
  return events.some((event) => (
    event.kind === 'message' && event.role === 'user' && event.origin === 'internal_job'
  ))
}

export function evaluateSessionQueryContent(
  query: SessionQuery,
  events: SessionEvent[],
): PredicateResult {
  const excludeInternal = query.version === 2
    && query.scope?.includeInternal !== true
    && isInternalSession(events)
  if (excludeInternal) {
    return predicateResult('not_matched', [{ kind: 'excluded_internal' }])
  }
  return query.where
    ? evaluateSessionPredicate(query.where, events)
    : predicateResult('matched', [{ kind: 'all' }])
}

function sourceUnknownOutcome(
  candidate: CandidateRow,
  source: SessionEventReadResult,
): SessionSelectionOutcome {
  return {
    sessionId: candidate.id,
    agent: candidate.agent,
    projectSlug: candidate.slug,
    updatedAt: candidate.updated_at,
    status: candidate.status,
    selectionStatus: 'unknown',
    eventCount: 0,
    proofs: [],
    sourceRevision: source.sourceRevision,
    errorCode: source.errorCode,
    errorMessage: source.errorMessage,
  }
}

export async function runSessionQuery(
  value: unknown,
  options: RunSessionQueryOptions = {},
): Promise<SessionQueryExecution> {
  const query = parseSessionQuery(value)
  const now = options.now ?? new Date()
  const candidates = loadCandidates(query, now, options.homeDir)
  const outcomes: SessionSelectionOutcome[] = []
  const matchedSources: SessionEventReadResult[] = []

  for (const candidate of candidates) {
    const [source] = await readSessionEventSources(
      [{ id: candidate.id, agent: candidate.agent }],
      { homeDir: options.homeDir, signal: options.signal },
    )
    if (source.status === 'unavailable' || source.status === 'failed') {
      outcomes.push(sourceUnknownOutcome(candidate, source))
      continue
    }

    const evaluation = evaluateSessionQueryContent(query, source.events)
    const outcome: SessionSelectionOutcome = {
      sessionId: candidate.id,
      agent: candidate.agent,
      projectSlug: candidate.slug,
      updatedAt: candidate.updated_at,
      status: candidate.status,
      selectionStatus: evaluation.status,
      eventCount: source.eventCount,
      proofs: evaluation.proofs,
      sourceRevision: source.sourceRevision,
      ...(evaluation.unknownCode ? { errorCode: evaluation.unknownCode } : {}),
      ...(evaluation.unknownMessage ? { errorMessage: evaluation.unknownMessage } : {}),
      ...(!evaluation.unknownCode && source.errorCode ? { errorCode: source.errorCode } : {}),
      ...(!evaluation.unknownMessage && source.errorMessage
        ? { errorMessage: source.errorMessage }
        : {}),
    }
    outcomes.push(outcome)
    if (evaluation.status === 'matched') {
      await options.onMatchedSource?.(source, outcome)
      if (options.retainMatchedSources !== false) matchedSources.push(source)
    }
  }

  const matched = outcomes.filter((outcome) => outcome.selectionStatus === 'matched').length
  const notMatched = outcomes.filter((outcome) => outcome.selectionStatus === 'not_matched').length
  const unknownOutcomes = outcomes.filter((outcome) => outcome.selectionStatus === 'unknown')
  const unknownOrigin = unknownOutcomes.filter((outcome) => (
    outcome.errorCode === 'QUERY_ORIGIN_UNKNOWN'
  )).length
  const unknownToolParse = unknownOutcomes.filter((outcome) => (
    outcome.errorCode === 'QUERY_TOOL_PARSE_UNKNOWN'
  )).length
  const unknownSource = unknownOutcomes.length - unknownOrigin - unknownToolParse
  const coverage: SelectionCoverage = {
    candidates: outcomes.length,
    inspected: matched + notMatched,
    matched,
    notMatched,
    unknown: unknownOutcomes.length,
    unknownSource,
    unknownOrigin,
    unknownToolParse,
    changedDuringRun: outcomes.filter((outcome) => (
      outcome.sourceRevision?.changedDuringRun
    )).length,
  }
  return {
    query,
    queryHash: stableHash(query),
    evaluatedAt: now.toISOString(),
    coverage,
    outcomes,
    matchedSources,
  }
}
