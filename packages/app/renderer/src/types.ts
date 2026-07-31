export interface Project {
  slug: string
  sessionCount: number
  agents: string[]
}

export type AgentName = 'claude' | 'codex' | 'copilot' | 'cursor' | 'opencode' | 'pi'
export type SessionStatus = 'new' | 'updated' | 'unchanged' | 'missing' | 'error'

export interface ProjectSession {
  id: string
  agent: AgentName
  sourcePath: string
  workspaceLink: string
  slug: string
  contentHash: string
  updatedAt: string
  status: SessionStatus
  firstSeenAt: string
  lastSeenAt: string
  classifiedAt: string | null
  rulesStatus: string | null
  rulesGeneratedAt: string | null
}

export interface SessionPreviewTool {
  tool: string
  summary: string
}

export interface SessionPreviewMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
  tools: SessionPreviewTool[]
}

export interface SessionPreview {
  sessionId: string
  agent: string
  messages: SessionPreviewMessage[]
}

export interface SessionEvidenceContextMessage extends SessionPreviewMessage {
  messageIndex: number
  matched: boolean
}

export interface SessionEvidenceContext {
  sessionId: string
  agent: string
  messageIndex: number
  eligibility: 'eligible' | 'existing_rule_baseline' | 'platform_context'
  messages: SessionEvidenceContextMessage[]
}

export type ScanPhase = 'discovering' | 'processing' | 'done' | 'skipped' | 'error'
export type RunState =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'interrupted'

export interface ScanProgress {
  agent: AgentName
  phase: ScanPhase
  current?: number
  total?: number
}

export interface ScanSummary {
  total: number
  new: number
  updated: number
  unchanged: number
  missing: number
  errors: number
  changes: {
    new: ScanChange[]
    updated: ScanChange[]
    missing: ScanChange[]
  }
}

export interface ScanChange {
  agent: AgentName
  id: string
  slug: string
}

export interface ScanStatus {
  running: boolean
  state: RunState
  runId?: string
  lastSeq: number
  progress?: ScanProgress
  progressByAgent?: Partial<Record<AgentName, ScanProgress>>
  summary?: ScanSummary
  error?: string
  selectedAgents?: AgentName[]
  sinceDays?: number
  completedAt?: string
  restored?: boolean
}

export type ScanScope =
  | { mode: 'full' }
  | { mode: 'recent'; days: number }

export interface ScanHistoryEntry {
  id: string
  startedAt: string
  completedAt: string
  status: 'success' | 'partial' | 'cancelled'
  summary: ScanSummary
  scope: ScanScope
}

export interface ScanStartRequest {
  agents: AgentName[]
  sinceDays?: number
}

export type ScanStartResult =
  | { started: true; runId: string }
  | { started: false; reason: 'already-running' }

export type RunCancelResult =
  | { accepted: true }
  | { accepted: false; reason: 'not-running' | 'already-cancelling' | 'stale-run' }

export interface LlmConfig {
  provider: 'claude' | 'codex'
  model?: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  fastMode?: boolean
  providers?: Partial<Record<ProviderId, {
    enabled: boolean
    additionalModels?: Array<{ id: string; label?: string }>
  }>>
}

export type ProviderId = 'claude' | 'codex'
export type ProviderStatus =
  | 'loading'
  | 'available'
  | 'not-installed'
  | 'error'
  | 'disabled'

export interface ProviderModel {
  id: string
  label: string
  description?: string
  source: 'discovered' | 'custom' | 'fallback'
}

export interface ProviderEntry {
  id: ProviderId
  label: string
  status: ProviderStatus
  enabled: boolean
  isDefault: boolean
  models: ProviderModel[]
  fetchedAt?: string
  version?: string
  error?: string
}

export interface ProviderDiagnostic {
  provider: ProviderId
  checkedAt: string
  executable: { available: boolean; version?: string }
  authenticated: boolean | 'unknown'
  catalog: { ok: boolean; modelCount?: number; error?: string }
  text: string
}

export interface ProviderSnapshot {
  entries: ProviderEntry[]
  refreshing: boolean
  diagnosing?: ProviderId
  diagnostics?: Partial<Record<ProviderId, ProviderDiagnostic>>
  error?: string
}

export interface GenerateProgress {
  phase: 'extracting' | 'generating' | 'splitting' | 'done'
  current?: number
  total?: number
  projectSlug?: string
  candidateCount?: number
  failedProjectCount?: number
}

export type GenerationMode = 'recent' | 'changed7d' | 'full' | 'projects'

export interface GenerationRequest {
  mode: GenerationMode
  projects: string[]
  provider?: ProviderId
  model?: string | null
  effort?: LlmConfig['effort']
  fastMode?: boolean
}

export interface EvidenceSnapshot {
  mode: GenerationMode
  rounds?: number
  projects: Array<{
    slug: string
    sessionIds: string[]
    roundCount: number
    excerptCount: number
  }>
  totalSessions: number
  createdAt: string
}

export interface ProjectGenerationCandidate {
  rule: string
  scope: 'global' | 'project'
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
  evidenceRefs: string[]
}

export interface ProjectGenerationResponse {
  projectSlug: string
  summary: string
  candidates: ProjectGenerationCandidate[]
  status?: 'completed' | 'failed'
  error?: string
}

export interface AgentActivity {
  id: string
  kind: 'thinking' | 'read' | 'search' | 'shell' | 'tool'
  label: string
  detail?: string
  status?: 'running' | 'completed'
}

export type GenerationWorkerEvent =
  | { kind: 'assistant_delta'; text: string }
  | { kind: 'activity'; activity: AgentActivity }
  | { kind: 'retry'; message: string }
  | { kind: 'phase'; progress: GenerateProgress }
  | { kind: 'candidate_count'; count: number }
  | { kind: 'evidence_ready'; snapshot: EvidenceSnapshot }
  | { kind: 'project_response'; response: ProjectGenerationResponse }

export interface GenerationEventEnvelope {
  type: 'event'
  runId: string
  seq: number
  at: string
  event: GenerationWorkerEvent
}

export interface GenerationStatus {
  running: boolean
  state: RunState
  runId?: string
  lastSeq: number
  request?: GenerationRequest
  progress?: GenerateProgress
  evidence?: EvidenceSnapshot
  projectResponses: ProjectGenerationResponse[]
  events: Array<{
    runId: string
    seq: number
    at: string
    event: Exclude<GenerationWorkerEvent, { kind: 'assistant_delta' }>
  }>
  output: string
  outputTruncated: boolean
  startedAt?: string
  endedAt?: string
  error?: string
}

export interface GenerationHistoryEntry {
  id: string
  startedAt: string
  endedAt?: string
  status: RunState
  request: {
    mode: GenerationMode
    projects: string[]
  }
  evidence?: {
    projectCount: number
    totalSessions: number
    projects?: Array<{
      slug: string
      sessionIds: string[]
      roundCount: number
      excerptCount: number
    }>
    createdAt?: string
  }
  candidateCount: number
  candidates: RuleCandidate[]
  failure?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  kind: 'rules-generation-request' | 'assistant-response'
  content: string
  status: 'completed' | 'streaming' | 'cancelled' | 'failed' | 'interrupted'
  createdAt: string
  completedAt?: string
}

export interface ChatThreadSummary {
  id: string
  runId: string
  kind: 'rules-generation'
  title: string
  status: Exclude<RunState, 'idle'>
  request: GenerationRequest
  projectCount: number
  sessionCount: number
  candidateCount: number
  createdAt: string
  updatedAt: string
  endedAt?: string
}

export interface ChatThread extends ChatThreadSummary {
  evidence?: EvidenceSnapshot
  projectResponses: ProjectGenerationResponse[]
  activities: Array<{
    seq: number
    at: string
    kind: string
    id?: string
    label?: string
    detail?: string
    status?: 'running' | 'completed'
  }>
  messages: ChatMessage[]
  error?: string
}

export type GenerationStartResult =
  | { started: true; runId: string }
  | { started: false; reason: 'already-running' }

export type RuleStatus = 'draft' | 'accepted' | 'rejected'

export interface RuleCandidate {
  id: string
  run_id?: string | null
  scope: string
  project_slug: string | null
  rule_text: string
  confidence_level: string
  status: RuleStatus
  evidence_json: string
  source_sessions: string
  created_at: string
  updated_at: string
}

export type GlobalInstructionAgent =
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'opencode'
  | 'pi'

export interface GlobalInstructionSource {
  id: 'instructions'
  agent: GlobalInstructionAgent
  scope: 'global'
  kind: 'instructions'
  path: string
  format: 'markdown'
  status: 'present' | 'missing'
  effective: boolean
  discoveredFrom: 'default' | 'environment'
  note?: string
}

export interface GlobalInstructionListResult {
  agent: GlobalInstructionAgent | null
  count: number
  sources: GlobalInstructionSource[]
  errors: Array<{
    agent: GlobalInstructionAgent
    path: string | null
    message: string
  }>
}

export interface GlobalInstructionReadResult {
  source: GlobalInstructionSource
  content: string
  revision: string | null
  modifiedAt: string | null
  sizeBytes: number
}

export interface AgentInstructionPublishSummary {
  ruleCount: number
  results: Array<{
    agent: GlobalInstructionAgent
    path: string
    status: 'published' | 'unchanged' | 'failed'
    revision?: string
    message?: string
  }>
}
