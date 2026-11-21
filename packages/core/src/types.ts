export type AgentName = 'claude' | 'codex' | 'copilot' | 'cursor' | 'gemini' | 'grok' | 't3' | 'antigravity' | 'opencode' | 'pi'

/**
 * scan session 的状态机：
 * - new        本轮首次发现
 * - updated    与 DB 已有行 hash / updated_at 不一致
 * - unchanged  无变化
 * - missing    DB 有但本轮 agent 没扫到
 * - error      parse / normalize 出错（占位行便于诊断）
 */
export type SessionStatus = 'new' | 'updated' | 'unchanged' | 'missing' | 'error'

export interface DiscoveredSession {
  cwd?: string
  nativeBindings?: Array<{ provider: string; nativeId: string | null }>
  id: string
  agent: AgentName
  sourcePath: string
  sourceKind: string
  updatedAt: string
  contentHash: string
}

export type ProjectHintKind =
  | 'cwd'
  | 'git_root'
  | 'git_remote'
  | 'source_project_path'
  | 'message_path'
  | 'branch'

export type ProjectHintSource = 'metadata' | 'source_path' | 'message_text'

export interface ProjectHint {
  kind: ProjectHintKind
  value: string
  confidence: number
  agent: AgentName
  source: ProjectHintSource
  locator?: string
}

export interface ProbeResult {
  matched: boolean
  reason?: string
}

export interface ParsedSessionMetadata {
  cwd?: string
  gitRoot?: string
  gitRemote?: string
  branch?: string
  headCommit?: string
}

export interface ParsedSession {
  agent: AgentName
  sessionId: string
  sourcePath: string
  messageCount: number
  toolCallCount: number
  firstTimestamp?: string
  lastTimestamp?: string
  metadata: ParsedSessionMetadata
}

export interface NormalizedSession {
  sessionId: string
  agent: AgentName
  sourcePath: string
  sourceKind: string
  updatedAt: string
  contentHash: string
  parsed: ParsedSession
}

export interface AgentAdapter {
  name: AgentName
  probe(agentSourceDir: string): Promise<ProbeResult>
  discover(agentSourceDir: string): Promise<DiscoveredSession[]>
  parse(discovered: DiscoveredSession): Promise<ParsedSession>
  normalize(parsed: ParsedSession, discovered: DiscoveredSession): Promise<NormalizedSession>
  extractProjectHints(discovered: DiscoveredSession): Promise<ProjectHint[]>
}

export interface ScanSummary {
  total: number
  new: number
  updated: number
  unchanged: number
  missing: number
  errors: number
  changes: ScanChanges
}

export interface ScanChange {
  agent: AgentName
  id: string
  slug: string
}

export interface ScanChanges {
  new: ScanChange[]
  updated: ScanChange[]
  missing: ScanChange[]
}

export interface ScanProgress {
  agent: AgentName
  phase: 'discovering' | 'processing' | 'done' | 'skipped' | 'error'
  current?: number
  total?: number
}

export interface ScanOptions {
  runId?: string
  source?: string
  all?: boolean
  agents?: AgentName[]
  full?: boolean
  sinceDays?: number
  homeDir?: string
  signal?: AbortSignal
  onProgress?: (progress: ScanProgress) => void | Promise<void>
}
