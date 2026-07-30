import Database from 'better-sqlite3'
import {
  listGlobalInstructionSources,
  readGlobalInstructionSource,
  saveGlobalInstructionSource,
  type GlobalInstructionAgent,
} from './global-instructions.js'
import { resolveWorkspace } from './workspace.js'

const MANAGED_START = '<!-- memory-manager:global-rules:start -->'
const MANAGED_END = '<!-- memory-manager:global-rules:end -->'

export interface AgentInstructionPublishTarget {
  agent: GlobalInstructionAgent
  expectedRevision: string | null
}

export interface AgentInstructionPublishResult {
  agent: GlobalInstructionAgent
  path: string
  status: 'published' | 'unchanged' | 'failed'
  revision?: string
  message?: string
}

export interface AgentInstructionPublishSummary {
  ruleCount: number
  results: AgentInstructionPublishResult[]
}

export function publishGlobalRulesToAgents(
  targets: AgentInstructionPublishTarget[],
  homeDir?: string,
): AgentInstructionPublishSummary {
  const uniqueTargets = [...new Map(targets.map((target) => [target.agent, target])).values()]
  if (uniqueTargets.length === 0) throw new Error('至少选择一个 Agent publish target')
  const rules = listAcceptedGlobalRules(homeDir)
  if (rules.length === 0) throw new Error('没有 accepted global rules 可发布')
  const managedBlock = renderManagedBlock(rules)
  const results = uniqueTargets.map((target): AgentInstructionPublishResult => {
    try {
      const current = readGlobalInstructionSource(target.agent, { homeDir })
      if (current.revision !== target.expectedRevision) {
        throw new Error(`规则文件自预览后已发生变化：${current.source.path}`)
      }
      const content = mergeManagedBlock(current.content, managedBlock)
      if (content === current.content) {
        return {
          agent: target.agent,
          path: current.source.path,
          status: 'unchanged',
          ...(current.revision ? { revision: current.revision } : {}),
        }
      }
      const saved = saveGlobalInstructionSource(
        target.agent,
        {
          content,
          expectedRevision: target.expectedRevision,
        },
        { homeDir },
      )
      return {
        agent: target.agent,
        path: saved.source.path,
        status: 'published',
        ...(saved.revision ? { revision: saved.revision } : {}),
      }
    } catch (error) {
      const source = listGlobalInstructionSources({
        agent: target.agent,
        homeDir,
      }).sources[0]
      return {
        agent: target.agent,
        path: source.path,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })
  return { ruleCount: rules.length, results }
}

function listAcceptedGlobalRules(homeDir?: string): string[] {
  const db = new Database(resolveWorkspace(homeDir).dbPath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const rows = db.prepare(`
      SELECT rule_text
      FROM rule_candidates
      WHERE status = 'accepted' AND scope = 'global'
      ORDER BY CASE confidence_level
        WHEN 'high' THEN 0
        WHEN 'medium' THEN 1
        WHEN 'low' THEN 2
        ELSE 3
      END, created_at, id
    `).all() as Array<{ rule_text: string }>
    return rows.map(({ rule_text }) => rule_text)
  } finally {
    db.close()
  }
}

function renderManagedBlock(rules: string[]): string {
  const items = rules
    .map((rule) => `- ${rule.replaceAll('\n', '\n  ')}`)
    .join('\n')
  return `${MANAGED_START}\n## Memory Manager generated rules\n\n${items}\n${MANAGED_END}`
}

function mergeManagedBlock(content: string, managedBlock: string): string {
  const start = content.indexOf(MANAGED_START)
  const end = content.indexOf(MANAGED_END)
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error('Agent instruction 文件中的 Memory Manager managed markers 不完整')
  }
  if (start !== -1) {
    const blockEnd = end + MANAGED_END.length
    return `${content.slice(0, start)}${managedBlock}${content.slice(blockEnd)}`
  }
  const prefix = content.trimEnd()
  return `${prefix}${prefix ? '\n\n' : ''}${managedBlock}\n`
}
