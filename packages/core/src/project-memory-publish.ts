import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  listAutoMemorySources,
  readAutoMemorySource,
  type AutoMemoryListOptions,
} from './auto-memories.js'
import { resolveWorkspace } from './workspace.js'

const MANAGED_START = '<!-- memory-manager:project-rules:start -->'
const MANAGED_END = '<!-- memory-manager:project-rules:end -->'
const TOPIC_MARKER = '<!-- memory-manager:project-rules:topic -->'
const TOPIC_NAME = 'memory-manager-rules.md'
const MAX_MANAGED_BYTES = 24 * 1024
const MAX_MANAGED_LINES = 160

export interface ClaudeProjectMemoryPublishTarget {
  memoryId: string
  displayName: string
  path: string
  revision: string
  topicRevision: string | null
  writable: boolean
  reason?: string
}

export interface ClaudeProjectMemoryPublishRequest {
  memoryId: string
  ruleIds: string[]
  expectedRevision: string
  expectedTopicRevision: string | null
}

export interface ClaudeProjectMemoryPublishResult {
  memoryId: string
  path: string
  topicPath: string
  projectSlug: string
  ruleCount: number
  status: 'published' | 'unchanged'
  revision: string
  topicRevision: string
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

export function listClaudeProjectMemoryPublishTargets(
  options: Omit<AutoMemoryListOptions, 'agent'> = {},
): ClaudeProjectMemoryPublishTarget[] {
  const homeDir = path.resolve(options.homeDir ?? os.homedir())
  return listAutoMemorySources({ ...options, agent: 'claude' }).sources
    .filter((source) => source.scope === 'project' && source.status === 'present')
    .map((source) => {
      const topicPath = path.join(path.dirname(source.path), TOPIC_NAME)
      const displayName = projectMemoryDisplayName(source.path, homeDir)
      const inspectedPaths = [
        source.path,
        path.dirname(source.path),
        path.dirname(path.dirname(source.path)),
      ]
      const isSymlink = inspectedPaths.some((candidate) =>
        fs.lstatSync(candidate).isSymbolicLink())
      if (isSymlink) {
        return {
          memoryId: source.id,
          displayName,
          path: source.path,
          revision: '',
          topicRevision: fileRevision(topicPath),
          writable: false,
          reason: 'Memory 文件或上级目录为 symlink，发布功能不会替换链接',
        }
      }
      const memory = readAutoMemorySource('claude', source.id, options)
      return {
        memoryId: source.id,
        displayName,
        path: source.path,
        revision: hashContent(memory.content),
        topicRevision: fileRevision(topicPath),
        writable: true,
      }
    })
}

function projectMemoryDisplayName(memoryPath: string, homeDir: string): string {
  const projectDirectory = path.basename(path.dirname(path.dirname(memoryPath)))
  const encodedHome = homeDir.replaceAll(path.sep, '-')
  const relativeName = projectDirectory.startsWith(`${encodedHome}-`)
    ? projectDirectory.slice(encodedHome.length + 1)
    : projectDirectory.replace(/^-+/, '')
  return relativeName ? `~/${relativeName}` : projectDirectory
}

export function publishProjectRulesToClaudeMemory(
  request: ClaudeProjectMemoryPublishRequest,
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeProjectMemoryPublishResult {
  const ruleIds = [...new Set(request.ruleIds)]
  if (ruleIds.length === 0) throw new Error('至少选择一条项目规则')

  const target = listClaudeProjectMemoryPublishTargets({ homeDir, env })
    .find((candidate) => candidate.memoryId === request.memoryId)
  if (!target) throw new Error(`未知的 Claude 项目 Memory：${request.memoryId}`)
  if (!target.writable) throw new Error(target.reason ?? 'Claude 项目 Memory 不可写')
  if (target.revision !== request.expectedRevision) {
    throw new Error(`Claude 项目 Memory 自预览后已发生变化：${target.path}`)
  }
  if (target.topicRevision !== request.expectedTopicRevision) {
    throw new Error(`Memory Manager topic 自预览后已发生变化：${path.dirname(target.path)}`)
  }

  const rules = loadSelectedProjectRules(ruleIds, homeDir)
  const projectSlugs = new Set(rules.map((rule) => rule.project_slug))
  if (projectSlugs.size !== 1 || projectSlugs.has(null)) {
    throw new Error('一次只能发布同一个项目的规则')
  }
  const projectSlug = [...projectSlugs][0] as string
  if (rules.some((rule) => [MANAGED_START, MANAGED_END, TOPIC_MARKER]
    .some((marker) => rule.rule_text.includes(marker)))) {
    throw new Error('项目规则包含 Memory Manager 保留标记，无法发布')
  }
  const managedBlock = renderManagedBlock(projectSlug, rules)
  validateManagedBlock(managedBlock)
  const topicContent = renderTopic(projectSlug, rules)
  const memory = readAutoMemorySource('claude', request.memoryId, { homeDir, env })
  if (hashContent(memory.content) !== request.expectedRevision) {
    throw new Error(`Claude 项目 Memory 自预览后已发生变化：${target.path}`)
  }
  const memoryContent = mergeManagedBlock(memory.content, managedBlock)
  const topicPath = path.join(path.dirname(target.path), TOPIC_NAME)
  if (fileRevision(topicPath) !== request.expectedTopicRevision) {
    throw new Error(`Memory Manager topic 自预览后已发生变化：${topicPath}`)
  }
  validateExistingTopic(topicPath)

  const topicChanged = readOptionalFile(topicPath) !== topicContent
  const memoryChanged = memory.content !== memoryContent
  if (topicChanged) writeAtomic(topicPath, topicContent)
  if (memoryChanged) writeAtomic(target.path, memoryContent)

  return {
    memoryId: target.memoryId,
    path: target.path,
    topicPath,
    projectSlug,
    ruleCount: rules.length,
    status: topicChanged || memoryChanged ? 'published' : 'unchanged',
    revision: fileRevision(target.path) as string,
    topicRevision: fileRevision(topicPath) as string,
  }
}

function loadSelectedProjectRules(ruleIds: string[], homeDir?: string): ProjectRuleRow[] {
  const db = new Database(resolveWorkspace(homeDir).dbPath, {
    readonly: true,
    fileMustExist: true,
  })
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
    return rows.sort((left, right) => {
      const confidence = confidenceRank(left.confidence_level) - confidenceRank(right.confidence_level)
      return confidence || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
    })
  } finally {
    db.close()
  }
}

function confidenceRank(value: string): number {
  if (value === 'high') return 0
  if (value === 'medium') return 1
  if (value === 'low') return 2
  return 3
}

function renderManagedBlock(projectSlug: string, rules: ProjectRuleRow[]): string {
  const items = rules.map((rule) => `- ${rule.rule_text.replaceAll('\n', '\n  ')}`).join('\n')
  return `${MANAGED_START}\n## Memory Manager 项目规则\n\n项目：\`${projectSlug}\`\n\n${items}\n\n详细来源：[${TOPIC_NAME}](${TOPIC_NAME})\n${MANAGED_END}`
}

function renderTopic(projectSlug: string, rules: ProjectRuleRow[]): string {
  const sections = rules.map((rule) => [
    `## ${rule.id}`,
    '',
    `- 置信度：${rule.confidence_level}`,
    `- 规则：${rule.rule_text.replaceAll('\n', '\n  ')}`,
  ].join('\n'))
  return `${TOPIC_MARKER}\n# Memory Manager 项目规则\n\n项目：\`${projectSlug}\`\n\n${sections.join('\n\n')}\n`
}

function validateManagedBlock(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_MANAGED_BYTES) {
    throw new Error('所选项目规则超过 24 KiB，请减少选择后重试')
  }
  if (content.split('\n').length > MAX_MANAGED_LINES) {
    throw new Error('所选项目规则超过 160 行，请减少选择后重试')
  }
}

function mergeManagedBlock(content: string, managedBlock: string): string {
  const start = content.indexOf(MANAGED_START)
  const end = content.indexOf(MANAGED_END)
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error('Claude Memory 中的 Memory Manager managed markers 不完整')
  }
  if (start !== -1) {
    const blockEnd = end + MANAGED_END.length
    return `${content.slice(0, start)}${managedBlock}${content.slice(blockEnd)}`
  }
  const suffix = content.trimStart()
  return `${managedBlock}${suffix ? `\n\n${suffix}` : '\n'}`
}

function validateExistingTopic(topicPath: string): void {
  const content = readOptionalFile(topicPath)
  if (content !== null && !content.startsWith(TOPIC_MARKER)) {
    throw new Error(`已有非 Memory Manager 管理的 topic：${topicPath}`)
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
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function writeAtomic(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const mode = fs.statSync(targetPath, { throwIfNoEntry: false })?.mode ?? 0o600
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', mode & 0o777)
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
