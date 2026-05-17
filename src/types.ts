export type AgentName = 'claude' | 'codex' | 'copilot' | 'cursor'

export type ScanState = 'new' | 'updated' | 'unchanged' | 'missing' | 'error'

export interface DiscoveredSession {
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
}

export interface ScanOptions {
  source?: string
  all?: boolean
  agents?: AgentName[]
  full?: boolean
  homeDir?: string
}

export const UNKNOWN_PROJECT_KEY = 'unknown'

export interface ProjectClassification {
  projectKey: string
  confidence: number
  decisionHint: ProjectHint | null
}
