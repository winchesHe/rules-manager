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

export interface AgentAdapter {
  name: AgentName
  discover(agentSourceDir: string): Promise<DiscoveredSession[]>
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
