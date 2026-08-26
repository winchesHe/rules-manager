export interface Project {
  slug: string
  sessionCount: number
  agents: string[]
}

export type AgentName = 'claude' | 'codex' | 'copilot' | 'cursor' | 'opencode' | 'pi'
export type SessionStatus = 'new' | 'updated' | 'unchanged' | 'missing' | 'error'

export interface ProjectSession {
  id: string
  displayName: string
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
  displayName: string
  agent: string
  messages: SessionPreviewMessage[]
}

export interface SessionEvidenceContextMessage extends SessionPreviewMessage {
  messageIndex: number
  matched: boolean
}

export interface SessionEvidenceContext {
  sessionId: string
  displayName: string
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
  provider: ProviderId
  model?: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  fastMode?: boolean
  thinkingOptionId?: string
  providers?: Partial<Record<ProviderId, {
    enabled: boolean
    additionalModels?: Array<{ id: string; label?: string }>
  }>>
}

export type ProviderId = 'claude' | 'codex' | 'opencode' | 'pi'
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
  thinkingOptions?: Array<{ id: string; label: string }>
  defaultThinkingOptionId?: string
}

export interface ProviderCapabilities {
  supportsStructuredOutput: boolean
  supportsFastMode: boolean
  sessionLifecycle: 'native' | 'app-only'
}

export interface ProviderSnapshotEntry {
  id: ProviderId
  label: string
  status: ProviderStatus
  enabled: boolean
  isDefault: boolean
  models: ProviderModel[]
  capabilities: ProviderCapabilities
  fetchedAt?: string
  version?: string
  error?: string
}

export type ProviderEntry = ProviderSnapshotEntry

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
  kind: 'rules-generation-request' | 'assistant-response' | 'text'
  content: string
  status: 'completed' | 'streaming' | 'cancelled' | 'failed' | 'interrupted'
  createdAt: string
  completedAt?: string
  turnConfig?: ChatTurnConfig
  attachments?: Array<{
    kind: 'pasted-text'
    name: string
    characterCount: number
  }>
  toolActivities?: NativeToolActivity[]
  timeline?: NativeTurnTimelineItem[]
  sessionEvidence?: SessionEvidenceCoverageSummary
}

export interface SessionEvidenceCoverageSummary {
  mode: 'complete' | 'targeted'
  status: 'complete' | 'targeted' | 'partial' | 'failed'
  selected: number
  visited: number
  readable: number
  empty: number
  unavailable: number
  readFailed: number
  processed: number
  processFailed: number
  relevant: number
  changedDuringRun: number
}

export interface SessionEvidenceProgress {
  stage: 'planning' | 'reading' | 'processing' | 'reducing' | 'gating' | 'complete' | 'cancelled' | 'failed'
  completed: number
  total: number
  mode: 'complete' | 'targeted'
  coverage?: SessionEvidenceCoverageSummary
}

export interface NativeToolActivity {
  itemId: string
  kind: 'thinking' | 'read' | 'search' | 'shell' | 'tool'
  name: string
  status: 'running' | 'completed' | 'failed'
  summary?: string
  sourceLocator?: {
    turnId?: string
    turnIndex?: number
    toolIndex: number
  }
}

export type NativeTurnTimelineItem =
  | { type: 'assistant'; itemId: string; content: string }
  | {
      type: 'thinking'
      itemId: string
      content: string
      status: 'running' | 'completed'
    }
  | { type: 'tool'; itemId: string; activity: NativeToolActivity }

export type NativeChatEvent =
  | { type: 'assistant_delta'; itemId: string; text: string; content?: string }
  | {
      type: 'thinking_delta'
      itemId: string
      text: string
      content?: string
      status?: 'running' | 'completed'
    }
  | { type: 'tool_activity'; activity: NativeToolActivity }
  | { type: 'usage'; contextUsage: { usedTokens: number; maxTokens: number } }
  | { type: 'evidence_progress'; progress: SessionEvidenceProgress }
  | { type: 'interaction_request'; request: NativeInteractionRequest }

export interface NativeInteractionRequest {
  requestId: string
  kind: 'question'
  title?: string
  questions: Array<{
    id: string
    label: string
    options?: string[]
    multiple?: boolean
    placeholder?: string
  }>
}

export interface NativeToolItemPage {
  available: boolean
  content: string
  nextCursor: number | null
}

export interface ChatTurnConfig {
  model?: string
  effort: LlmConfig['effort']
  fastMode: boolean
  thinkingOptionId?: string
}

export interface GenerationChatThreadSummary {
  version: 1
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

export interface GenerationChatThread extends GenerationChatThreadSummary {
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

export interface NativeChatThreadSummary {
  version: 2
  id: string
  kind: 'native-chat'
  title: string
  titleSource: 'first-message' | 'manual'
  origin: 'chat' | 'rules'
  provider: ProviderId
  nativeSessionId: string | null
  nativeSessionHandle: NativeSessionHandle | null
  nativeState: 'starting' | 'ready' | 'start-failed' | 'resume-failed' | 'interrupted' | 'deleted'
  status: 'running' | 'ready' | 'failed' | 'interrupted'
  createdAt: string
  updatedAt: string
  pinnedAt?: string | null
  archivedAt: string | null
  defaultTurnConfig: ChatTurnConfig
  sessionContext: {
    revision: number
    lastInjectedRevision: number
    selected: NativeSessionReference[]
    lastInjectedSelected?: NativeSessionReference[]
  }
  contextUsage: { usedTokens: number; maxTokens: number; updatedAt: string } | null
  lastError: string | null
  activeEvidenceProgress?: SessionEvidenceProgress | null
  runId?: string
  intent?: 'chat' | 'rules-generation'
  rulesArtifact?: {
    runId: string
    projectCount: number
    sessionCount: number
    candidateCount: number
    projectResponses: ProjectGenerationResponse[]
  }
}

export interface NativeSessionHandle {
  sessionId: string
  nativeHandle?: string
}

export interface NativeSessionReference {
  id: string
  agent: string
}

export interface SessionContextItem extends NativeSessionReference {
  displayName: string
  slug: string
  updatedAt: string
  status: SessionStatus
  sourceAvailable: boolean
}

export interface SessionContextPage {
  items: SessionContextItem[]
  nextCursor: string | null
  references: NativeSessionReference[]
}

export interface NativeChatThread extends NativeChatThreadSummary {
  messages: ChatMessage[]
}

export type ChatThreadSummary = GenerationChatThreadSummary | NativeChatThreadSummary
export type ChatThread = GenerationChatThread | NativeChatThread

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

export interface ProjectRulesOutputReadResult {
  source: {
    projectSlug: string
    path: string
    status: 'present' | 'missing'
    modifiedAt: string | null
    sizeBytes: number
  }
  content: string
}

export type ProjectMemoryPublicationState =
  | 'synced'
  | 'outdated'
  | 'not_published'
  | 'unavailable'
  | 'no_rules'

export interface ProjectMemoryPublicationTargetStatus {
  id: string
  label: string
  path: string
  status: Exclude<ProjectMemoryPublicationState, 'no_rules'>
  reason?: string
}

export interface ProjectMemoryPublicationAgentStatus {
  agent: 'claude' | 'codex'
  projectSlug: string
  acceptedRuleCount: number
  status: ProjectMemoryPublicationState
  targets: ProjectMemoryPublicationTargetStatus[]
}

export interface ProjectMemoryPublicationStatusResult {
  projectSlug: string
  claude: ProjectMemoryPublicationAgentStatus
  codex: ProjectMemoryPublicationAgentStatus
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

export type AutoMemoryAgent = 'claude' | 'codex'

export interface AutoMemorySource {
  id: string
  agent: AutoMemoryAgent
  scope: 'project' | 'global'
  path: string
  format: 'markdown'
  status: 'present' | 'missing'
  discoveredFrom: 'filesystem' | 'default' | 'environment'
  note?: string
  projectPath?: string
  taskGroupCount?: number
  modifiedAt: string | null
  sizeBytes: number
}

export interface AutoMemoryListResult {
  agent: AutoMemoryAgent | null
  count: number
  sources: AutoMemorySource[]
  errors: Array<{
    agent: AutoMemoryAgent
    path: string
    message: string
  }>
}

export interface AutoMemoryReadResult {
  source: AutoMemorySource
  content: string
}

export interface ClaudeProjectMemoryPublishTarget {
  memoryId: string
  displayName: string
  path: string
  revision: string
  topicRevision: string | null
  writable: boolean
  reason?: string
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

export interface CodexProjectMemoryPublishTarget {
  projectSlug: string
  workingDirectory: string
  notePath: string
  revision: string | null
  contractRevision: string
  sessionCount: number
  agents: string[]
  writable: boolean
  reason?: string
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
