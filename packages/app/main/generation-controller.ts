import type {
  GenerateProgress,
  ProjectGenerationResponse,
} from '../../core/src/commands/rules-generate.js'
import type { AgentActivity } from '../../core/src/llm.js'
import type { LlmEffort, LlmProvider } from '../../core/src/config.js'
import {
  createRunId,
  isActiveRun,
  type RunCancelResult,
  type RunEnvelope,
  type RunState,
} from './background-run.js'

type GenerationRunOptions = {
  provider?: LlmProvider
  model?: string | null
  effort?: LlmEffort
  fastMode?: boolean
}

export type GenerationRequest = (
  | { mode: 'recent'; projects: [] }
  | { mode: 'changed7d'; projects: [] }
  | { mode: 'full'; projects: [] }
  | { mode: 'projects'; projects: string[] }
) & GenerationRunOptions

export interface EvidenceSnapshot {
  mode: GenerationRequest['mode']
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

export type GenerationWorkerEvent =
  | { kind: 'assistant_delta'; text: string }
  | { kind: 'activity'; activity: AgentActivity }
  | { kind: 'retry'; message: string }
  | { kind: 'phase'; progress: GenerateProgress }
  | { kind: 'candidate_count'; count: number }
  | { kind: 'evidence_ready'; snapshot: EvidenceSnapshot }
  | { kind: 'project_response'; response: ProjectGenerationResponse }

export type GenerationWorkerMessage =
  | { type: 'progress'; progress: GenerateProgress }
  | { type: 'event'; event: GenerationWorkerEvent }
  | { type: 'done'; result: GenerateProgress }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }

export interface GenerationWorkerLike {
  on(event: 'message', listener: (message: GenerationWorkerMessage) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  postMessage(message: { type: 'cancel' }): void
  terminate(): Promise<number>
}

export interface GenerationEventRecord extends RunEnvelope {
  event: Exclude<GenerationWorkerEvent, { kind: 'assistant_delta' }>
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
  events: GenerationEventRecord[]
  output: string
  outputTruncated: boolean
  startedAt?: string
  endedAt?: string
  error?: string
}

type GenerationControllerEventData =
  | { type: 'progress'; progress: GenerateProgress }
  | { type: 'event'; event: GenerationWorkerEvent }
  | { type: 'done'; result: GenerateProgress }
  | { type: 'cancelled' }
  | { type: 'failed'; message: string }

export type GenerationControllerEvent = GenerationControllerEventData & RunEnvelope

export type GenerationStartResult =
  | { started: true; runId: string }
  | { started: false; reason: 'already-running' }

export type GenerationWorkerRequest = GenerationRequest & { runId: string }

export interface GenerationTranscriptStore {
  createGenerationThread(input: {
    runId: string
    request: GenerationRequest
    startedAt: string
  }): void
  syncGeneration(status: GenerationStatus): void
}

const MAX_OUTPUT_LENGTH = 512 * 1024
const MAX_EVENTS = 200
const MAX_PROJECT_RESPONSES = 100
const MAX_CANDIDATES_PER_PROJECT = 50
const MAX_EVIDENCE_REFS_PER_CANDIDATE = 50
const MAX_DETAIL_LENGTH = 16 * 1024

export class GenerationController {
  private state: GenerationStatus = {
    running: false,
    state: 'idle',
    lastSeq: 0,
    projectResponses: [],
    events: [],
    output: '',
    outputTruncated: false,
  }
  private worker: GenerationWorkerLike | undefined

  constructor(
    private readonly createWorker: (request: GenerationWorkerRequest) => GenerationWorkerLike,
    private readonly emit: (event: GenerationControllerEvent) => void,
    private readonly transcript?: GenerationTranscriptStore,
  ) {}

  start(request: GenerationRequest): GenerationStartResult {
    if (isActiveRun(this.state.state)) {
      return { started: false, reason: 'already-running' }
    }

    const runId = createRunId()
    const startedAt = new Date().toISOString()
    this.state = {
      running: true,
      state: 'running',
      runId,
      lastSeq: 0,
      request,
      projectResponses: [],
      events: [],
      output: '',
      outputTruncated: false,
      startedAt,
    }
    let worker: GenerationWorkerLike
    try {
      this.transcript?.createGenerationThread({
        runId,
        request,
        startedAt,
      })
      worker = this.createWorker({ ...request, runId })
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
      return { started: true, runId }
    }
    this.worker = worker

    worker.on('message', (message) => {
      if (worker !== this.worker) return
      if (message.type === 'progress') {
        this.state = {
          ...this.state,
          running: true,
          progress: message.progress,
        }
        this.emitWithSeq({ type: 'progress', progress: message.progress })
      } else if (message.type === 'event') {
        this.handleWorkerEvent(message.event)
      } else if (message.type === 'done') {
        this.worker = undefined
        this.state = {
          ...this.state,
          running: false,
          state: 'completed',
          progress: message.result,
          endedAt: new Date().toISOString(),
        }
        this.emitWithSeq({ type: 'done', result: message.result })
      } else if (message.type === 'cancelled') {
        this.worker = undefined
        this.state = {
          ...this.state,
          running: false,
          state: 'cancelled',
          endedAt: new Date().toISOString(),
          error: undefined,
        }
        this.emitWithSeq({ type: 'cancelled' })
      } else {
        this.fail(message.message)
      }
    })
    worker.on('error', (error) => {
      if (worker === this.worker) this.fail(error.message)
    })
    worker.on('exit', (code) => {
      if (worker === this.worker) {
        this.fail(`Generation worker exited before completion (code ${code})`)
      }
    })

    return { started: true, runId }
  }

  status(): GenerationStatus {
    return {
      ...this.state,
      request: this.state.request
        ? {
            ...this.state.request,
            projects: [...this.state.request.projects],
          } as GenerationRequest
        : undefined,
      events: this.state.events.map((event) => ({
        ...event,
        event: cloneWorkerEvent(event.event),
      })),
      projectResponses: this.state.projectResponses.map(cloneProjectResponse),
      evidence: this.state.evidence
        ? {
            ...this.state.evidence,
            projects: this.state.evidence.projects.map((project) => ({
              ...project,
              sessionIds: [...project.sessionIds],
            })),
          }
        : undefined,
    }
  }

  cancel(runId: string): RunCancelResult {
    if (!isActiveRun(this.state.state) || !this.worker || !this.state.runId) {
      return { accepted: false, reason: 'not-running' }
    }
    if (this.state.runId !== runId) {
      return { accepted: false, reason: 'stale-run' }
    }
    if (this.state.state === 'cancelling') {
      return { accepted: false, reason: 'already-cancelling' }
    }

    this.state = {
      ...this.state,
      running: true,
      state: 'cancelling',
    }
    this.syncTranscript()
    this.worker.postMessage({ type: 'cancel' })
    return { accepted: true }
  }

  private fail(message: string): void {
    this.worker = undefined
    this.state = {
      ...this.state,
      running: false,
      state: 'failed',
      endedAt: new Date().toISOString(),
      error: message,
    }
    this.emitWithSeq({ type: 'failed', message })
  }

  private handleWorkerEvent(event: GenerationWorkerEvent): void {
    if (event.kind === 'assistant_delta') {
      const nextOutput = this.state.output + event.text
      const overflow = Math.max(0, nextOutput.length - MAX_OUTPUT_LENGTH)
      this.state = {
        ...this.state,
        output: overflow > 0 ? nextOutput.slice(overflow) : nextOutput,
        outputTruncated: this.state.outputTruncated || overflow > 0,
      }
    } else {
      if (event.kind === 'phase') {
        this.state = { ...this.state, progress: event.progress }
      } else if (event.kind === 'candidate_count') {
        this.state = {
          ...this.state,
          progress: {
            ...(this.state.progress ?? { phase: 'generating' }),
            candidateCount: event.count,
          },
        }
      } else if (event.kind === 'evidence_ready') {
        this.state = { ...this.state, evidence: event.snapshot }
      } else if (event.kind === 'activity') {
        event = {
          kind: 'activity',
          activity: {
            id: event.activity.id.slice(0, 256),
            kind: event.activity.kind,
            label: event.activity.label.slice(0, 128),
            ...(event.activity.detail
              ? { detail: event.activity.detail.slice(0, MAX_DETAIL_LENGTH) }
              : {}),
            ...(event.activity.status ? { status: event.activity.status } : {}),
          },
        }
      } else if (event.kind === 'project_response') {
        const response = boundedProjectResponse(event.response)
        this.state = {
          ...this.state,
          projectResponses: [
            ...this.state.projectResponses,
            response,
          ].slice(-MAX_PROJECT_RESPONSES),
        }
        event = { kind: 'project_response', response }
      }
    }

    this.emitWithSeq({ type: 'event', event }, event.kind !== 'assistant_delta')
  }

  private emitWithSeq(
    event: GenerationControllerEventData,
    retain = false,
  ): void {
    const runId = this.state.runId
    if (!runId) return
    const seq = this.state.lastSeq + 1
    const envelope = {
      ...event,
      runId,
      seq,
      at: new Date().toISOString(),
    } as GenerationControllerEvent

    let events = this.state.events
    if (retain && envelope.type === 'event' && envelope.event.kind !== 'assistant_delta') {
      events = [
        ...events,
        {
          runId,
          seq,
          at: envelope.at,
          event: cloneWorkerEvent(envelope.event),
        },
      ].slice(-MAX_EVENTS)
    } else if (envelope.type === 'progress') {
      const progressRecord: GenerationEventRecord = {
        runId,
        seq,
        at: envelope.at,
        event: {
          kind: 'phase',
          progress: { ...envelope.progress },
        },
      }
      events = [
        ...events,
        progressRecord,
      ].slice(-MAX_EVENTS)
    }
    this.state = { ...this.state, lastSeq: seq, events }
    this.emit(envelope)
    if (
      envelope.type !== 'event'
      || envelope.event.kind !== 'assistant_delta'
    ) {
      this.syncTranscript()
    }
  }

  private syncTranscript(): void {
    if (!this.transcript) return
    try {
      this.transcript.syncGeneration(this.status())
    } catch (error) {
      console.error('[chat] failed to persist generation thread', error)
    }
  }
}

function boundedProjectResponse(
  response: ProjectGenerationResponse,
): ProjectGenerationResponse {
  return {
    projectSlug: response.projectSlug.slice(0, 512),
    summary: response.summary.slice(0, MAX_DETAIL_LENGTH),
    candidates: response.candidates
      .slice(0, MAX_CANDIDATES_PER_PROJECT)
      .map((candidate) => ({
        rule: candidate.rule.slice(0, MAX_DETAIL_LENGTH),
        scope: candidate.scope,
        confidence: candidate.confidence,
        reasoning: candidate.reasoning.slice(0, MAX_DETAIL_LENGTH),
        evidenceRefs: candidate.evidenceRefs
          .slice(0, MAX_EVIDENCE_REFS_PER_CANDIDATE)
          .map((reference) => reference.slice(0, 512)),
      })),
    ...(response.status ? { status: response.status } : {}),
    ...(response.error ? { error: response.error.slice(0, MAX_DETAIL_LENGTH) } : {}),
  }
}

function cloneProjectResponse(
  response: ProjectGenerationResponse,
): ProjectGenerationResponse {
  return {
    ...response,
    candidates: response.candidates.map((candidate) => ({
      ...candidate,
      evidenceRefs: [...candidate.evidenceRefs],
    })),
  }
}

function cloneWorkerEvent(
  event: Exclude<GenerationWorkerEvent, { kind: 'assistant_delta' }>,
): Exclude<GenerationWorkerEvent, { kind: 'assistant_delta' }> {
  if (event.kind === 'project_response') {
    return { kind: event.kind, response: cloneProjectResponse(event.response) }
  }
  if (event.kind === 'evidence_ready') {
    return {
      kind: event.kind,
      snapshot: {
        ...event.snapshot,
        projects: event.snapshot.projects.map((project) => ({
          ...project,
          sessionIds: [...project.sessionIds],
        })),
      },
    }
  }
  if (event.kind === 'phase') {
    return { kind: event.kind, progress: { ...event.progress } }
  }
  if (event.kind === 'activity') {
    return { kind: event.kind, activity: { ...event.activity } }
  }
  return { ...event }
}
