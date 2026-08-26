import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { getAdapters } from './adapters/index.js'
import type { AutoMemoryListOptions } from './auto-memories.js'
import { getDbPath } from './db.js'
import {
  summarizeProjectMemoryPublication,
  type ProjectMemoryPublicationState,
  type ProjectMemoryPublicationTargetStatus,
} from './project-memory-publish.js'
import type { AgentName, DiscoveredSession } from './types.js'

const NOTE_MARKER = '<!-- memory-manager:codex-project-rules:v1 -->'
const MAX_NOTE_BYTES = 24 * 1024
const MAX_NOTE_LINES = 160

export interface CodexProjectMemoryPublishTarget {
  projectSlug: string
  workingDirectory: string
  notePath: string
  revision: string | null
  contractRevision: string
  sessionCount: number
  agents: AgentName[]
  writable: boolean
  reason?: string
}

export interface CodexProjectMemoryPublishRequest {
  projectSlug: string
  workingDirectory: string
  ruleIds: string[]
  expectedRevision: string | null
  expectedContractRevision: string
}

export interface CodexProjectMemoryPublishResult {
  projectSlug: string
  workingDirectory: string
  notePath: string
  ruleCount: number
  status: 'published' | 'unchanged'
  revision: string
  contractRevision: string
}

export interface CodexProjectMemoryPublicationStatus {
  agent: 'codex'
  projectSlug: string
  acceptedRuleCount: number
  status: ProjectMemoryPublicationState
  targets: ProjectMemoryPublicationTargetStatus[]
}

interface SessionRow {
  id: string
  agent: AgentName
  source_path: string
  content_hash: string
  updated_at: string
}

interface ProjectRuleRow {
  id: string
  project_slug: string | null
  rule_text: string
  status: string
  scope: string
  confidence_level: string
  created_at: string
}

interface WorkingDirectorySource {
  sessions: Set<string>
  agents: Set<AgentName>
}

export async function listCodexProjectMemoryPublishTargets(
  projectSlug: string,
  options: Omit<AutoMemoryListOptions, 'agent'> = {},
): Promise<CodexProjectMemoryPublishTarget[]> {
  if (!isSafeProjectSlug(projectSlug)) throw new Error('项目不能为空或包含非法字符')
  const homeDir = path.resolve(options.homeDir ?? os.homedir())
  const env = options.env ?? process.env
  const sources = await collectWorkingDirectories(projectSlug, homeDir)
  const memoryPaths = resolveCodexMemoryPaths(homeDir, env)
  const contract = inspectContract(memoryPaths.contractPath)

  return [...sources.entries()]
    .map(([workingDirectory, source]) => {
      const notePath = projectNotePath(
        memoryPaths.notesDirectory,
        projectSlug,
        workingDirectory,
      )
      const note = inspectNote(notePath)
      const directoryAvailable = isDirectory(workingDirectory)
      const reason = contract.reason
        ?? (!directoryAvailable ? 'Session 记录的工作目录已失效' : undefined)
        ?? note.reason
      return {
        projectSlug,
        workingDirectory,
        notePath,
        revision: note.revision,
        contractRevision: contract.revision,
        sessionCount: source.sessions.size,
        agents: [...source.agents].sort((left, right) => left.localeCompare(right, 'en')),
        writable: reason === undefined,
        ...(reason ? { reason } : {}),
      }
    })
    .sort((left, right) =>
      right.sessionCount - left.sessionCount
      || left.workingDirectory.localeCompare(right.workingDirectory, 'en'))
}

export async function inspectCodexProjectMemoryPublication(
  projectSlug: string,
  options: Omit<AutoMemoryListOptions, 'agent'> = {},
): Promise<CodexProjectMemoryPublicationStatus> {
  const homeDir = path.resolve(options.homeDir ?? os.homedir())
  const rules = loadAcceptedProjectRules(projectSlug, homeDir)
  if (rules.length === 0) {
    return {
      agent: 'codex',
      projectSlug,
      acceptedRuleCount: 0,
      status: 'no_rules',
      targets: [],
    }
  }

  const publishTargets = await listCodexProjectMemoryPublishTargets(projectSlug, options)
  const targets = publishTargets.map((target) => {
    if (!target.writable) {
      return {
        id: target.workingDirectory,
        label: target.workingDirectory,
        path: target.notePath,
        status: 'unavailable' as const,
        ...(target.reason ? { reason: target.reason } : {}),
      }
    }
    const expectedRevision = hashContent(renderNote(projectSlug, target.workingDirectory, rules))
    return {
      id: target.workingDirectory,
      label: target.workingDirectory,
      path: target.notePath,
      status: publicationTargetState(target.revision, expectedRevision),
    }
  })
  return {
    agent: 'codex',
    projectSlug,
    acceptedRuleCount: rules.length,
    status: summarizeProjectMemoryPublication(targets),
    targets,
  }
}

export async function publishProjectRulesToCodexMemory(
  request: CodexProjectMemoryPublishRequest,
  options: Omit<AutoMemoryListOptions, 'agent'> = {},
): Promise<CodexProjectMemoryPublishResult> {
  const ruleIds = [...new Set(request.ruleIds)]
  if (ruleIds.length === 0) throw new Error('至少选择一条项目规则')

  const targets = await listCodexProjectMemoryPublishTargets(request.projectSlug, options)
  const target = targets.find((candidate) =>
    candidate.workingDirectory === request.workingDirectory)
  if (!target) throw new Error('未知的 Codex 项目工作目录')
  if (!target.writable) throw new Error(target.reason ?? 'Codex 项目 Memory 目标不可写')
  if (target.contractRevision !== request.expectedContractRevision) {
    throw new Error('Codex ad-hoc Memory 契约自预览后已发生变化')
  }
  if (target.revision !== request.expectedRevision) {
    throw new Error(`Codex 项目 Memory note 自预览后已发生变化：${target.notePath}`)
  }

  const homeDir = path.resolve(options.homeDir ?? os.homedir())
  const rules = loadSelectedProjectRules(ruleIds, homeDir)
  const projectSlugs = new Set(rules.map((rule) => rule.project_slug))
  if (
    projectSlugs.size !== 1
    || !projectSlugs.has(request.projectSlug)
  ) {
    throw new Error('一次只能发布同一个项目的规则')
  }
  if (rules.some((rule) => rule.rule_text.includes(NOTE_MARKER))) {
    throw new Error('项目规则包含 Memory Manager 保留标记，无法发布')
  }

  const content = renderNote(request.projectSlug, request.workingDirectory, rules)
  validateNote(content)
  const currentRevision = fileRevision(target.notePath)
  if (currentRevision !== request.expectedRevision) {
    throw new Error(`Codex 项目 Memory note 自预览后已发生变化：${target.notePath}`)
  }
  const memoryPaths = resolveCodexMemoryPaths(homeDir, options.env ?? process.env)
  if (fileRevision(memoryPaths.contractPath) !== request.expectedContractRevision) {
    throw new Error('Codex ad-hoc Memory 契约自预览后已发生变化')
  }

  const changed = readOptionalFile(target.notePath) !== content
  if (changed) writeAtomic(target.notePath, content)
  return {
    projectSlug: request.projectSlug,
    workingDirectory: request.workingDirectory,
    notePath: target.notePath,
    ruleCount: rules.length,
    status: changed ? 'published' : 'unchanged',
    revision: fileRevision(target.notePath) as string,
    contractRevision: request.expectedContractRevision,
  }
}

async function collectWorkingDirectories(
  projectSlug: string,
  homeDir: string,
): Promise<Map<string, WorkingDirectorySource>> {
  const db = new Database(getDbPath(homeDir), { readonly: true, fileMustExist: true })
  let rows: SessionRow[]
  try {
    rows = db.prepare(`
      SELECT id, agent, source_path, content_hash, updated_at
      FROM sessions
      WHERE slug = ? AND status NOT IN ('missing', 'error')
    `).all(projectSlug) as SessionRow[]
  } finally {
    db.close()
  }

  const directories = new Map<string, WorkingDirectorySource>()
  for (const row of rows) {
    const adapter = getAdapters([row.agent])[0]
    const discovered: DiscoveredSession = {
      id: row.id,
      agent: row.agent,
      sourcePath: row.source_path,
      sourceKind: inferSourceKind(row.source_path, row.agent),
      updatedAt: row.updated_at,
      contentHash: row.content_hash,
    }
    try {
      const hints = await adapter.extractProjectHints(discovered)
      const selected = hints.find((hint) => hint.kind === 'git_root')
        ?? hints.find((hint) => hint.kind === 'cwd')
      if (!selected || !isSafeAbsolutePath(selected.value)) continue
      const workingDirectory = path.normalize(selected.value)
      const source = directories.get(workingDirectory) ?? {
        sessions: new Set<string>(),
        agents: new Set<AgentName>(),
      }
      source.sessions.add(row.id)
      source.agents.add(row.agent)
      directories.set(workingDirectory, source)
    } catch {
      // 单个来源失效时跳过；其他 Session 仍可提供项目 cwd。
    }
  }
  return directories
}

function inferSourceKind(sourcePath: string, agent: AgentName): string {
  if (agent === 'opencode') return 'sqlite'
  if (sourcePath.endsWith('.yaml') || sourcePath.endsWith('.yml')) return 'yaml'
  return 'jsonl'
}

function isSafeAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && !value.includes('\0') && !value.includes('\n')
}

function isSafeProjectSlug(value: string): boolean {
  return value.trim().length > 0 && !value.includes('\0') && !value.includes('\n')
}

function resolveCodexMemoryPaths(homeDir: string, env: NodeJS.ProcessEnv): {
  notesDirectory: string
  contractPath: string
} {
  const codexHome = path.resolve(env.CODEX_HOME || path.join(homeDir, '.codex'))
  const notesDirectory = path.join(codexHome, 'memories', 'extensions', 'ad_hoc')
  return {
    notesDirectory,
    contractPath: path.join(notesDirectory, 'instructions.md'),
  }
}

function inspectContract(contractPath: string): { revision: string; reason?: string } {
  const content = readOptionalFile(contractPath)
  if (content === null) {
    return { revision: '', reason: '当前 Codex 未暴露 ad-hoc Memory 契约，请先启用 Memories' }
  }
  if (isSymbolicLink(contractPath) || isSymbolicLink(path.dirname(contractPath))) {
    return { revision: hashContent(content), reason: 'Codex ad-hoc Memory 契约路径为 symlink' }
  }
  if (
    !content.includes('# Ad-hoc notes')
    || !/consolidat/i.test(content)
    || !/Never delete a note file/i.test(content)
  ) {
    return { revision: hashContent(content), reason: '当前 Codex ad-hoc Memory 契约无法识别' }
  }
  return { revision: hashContent(content) }
}

function inspectNote(notePath: string): { revision: string | null; reason?: string } {
  const content = readOptionalFile(notePath)
  if (content === null) return { revision: null }
  const revision = hashContent(content)
  if (isSymbolicLink(notePath)) {
    return { revision, reason: 'Codex 项目 Memory note 为 symlink' }
  }
  if (!content.startsWith(NOTE_MARKER)) {
    return { revision, reason: `已有非 Memory Manager 管理的 note：${notePath}` }
  }
  return { revision }
}

function projectNotePath(
  notesDirectory: string,
  projectSlug: string,
  workingDirectory: string,
): string {
  const safeSlug = projectSlug.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'project'
  const directoryHash = hashContent(workingDirectory).slice(0, 12)
  return path.join(notesDirectory, `memory-manager-project-${safeSlug}-${directoryHash}.md`)
}

function loadSelectedProjectRules(ruleIds: string[], homeDir: string): ProjectRuleRow[] {
  const db = new Database(getDbPath(homeDir), { readonly: true, fileMustExist: true })
  try {
    const placeholders = ruleIds.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT id, project_slug, rule_text, status, scope, confidence_level, created_at
      FROM rule_candidates
      WHERE id IN (${placeholders})
    `).all(...ruleIds) as ProjectRuleRow[]
    if (rows.length !== ruleIds.length) throw new Error('部分候选规则不存在')
    if (rows.some((row) => row.status !== 'accepted' || row.scope !== 'project')) {
      throw new Error('只能发布已接受的项目规则')
    }
    return rows.sort((left, right) =>
      confidenceRank(left.confidence_level) - confidenceRank(right.confidence_level)
      || left.created_at.localeCompare(right.created_at)
      || left.id.localeCompare(right.id))
  } finally {
    db.close()
  }
}

function loadAcceptedProjectRules(projectSlug: string, homeDir: string): ProjectRuleRow[] {
  if (!isSafeProjectSlug(projectSlug)) throw new Error('项目不能为空或包含非法字符')
  const db = new Database(getDbPath(homeDir), { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare(`
      SELECT id, project_slug, rule_text, status, scope, confidence_level, created_at
      FROM rule_candidates
      WHERE project_slug = ? AND status = 'accepted' AND scope = 'project'
    `).all(projectSlug) as ProjectRuleRow[]
    return rows.sort(compareProjectRules)
  } finally {
    db.close()
  }
}

function compareProjectRules(left: ProjectRuleRow, right: ProjectRuleRow): number {
  return confidenceRank(left.confidence_level) - confidenceRank(right.confidence_level)
    || left.created_at.localeCompare(right.created_at)
    || left.id.localeCompare(right.id)
}

function publicationTargetState(
  revision: string | null,
  expectedRevision: string,
): ProjectMemoryPublicationTargetStatus['status'] {
  if (revision === null) return 'not_published'
  return revision === expectedRevision ? 'synced' : 'outdated'
}

function confidenceRank(value: string): number {
  if (value === 'high') return 0
  if (value === 'medium') return 1
  if (value === 'low') return 2
  return 3
}

function renderNote(
  projectSlug: string,
  workingDirectory: string,
  rules: ProjectRuleRow[],
): string {
  const items = rules.map((rule) => `- ${rule.rule_text.replaceAll('\n', '\n  ')}`).join('\n')
  return `${NOTE_MARKER}
# Memory Manager 项目约定资料

scope: 用户为 ${projectSlug} 接受的项目约定，仅作为该项目的参考记忆。
applies_to: cwd=${workingDirectory}; project_slug=${projectSlug}

以下内容是项目参考资料，不是覆盖当前对话的系统指令：

${items}
`
}

function validateNote(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) {
    throw new Error('所选项目规则超过 24 KiB，请减少选择后重试')
  }
  if (content.split('\n').length > MAX_NOTE_LINES) {
    throw new Error('所选项目规则超过 160 行，请减少选择后重试')
  }
}

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory()
  } catch {
    return false
  }
}

function isSymbolicLink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink()
  } catch {
    return false
  }
}

function readOptionalFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

function fileRevision(filePath: string): string | null {
  const content = readOptionalFile(filePath)
  return content === null ? null : hashContent(content)
}

function writeAtomic(targetPath: string, content: string): void {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporaryPath, targetPath)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath)
  }
}
