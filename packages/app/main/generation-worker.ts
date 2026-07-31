import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { getDbPath } from '@memory-manager/core/db'
import {
  runRulesGenerate,
  type GenerateProgress,
} from '../../core/src/commands/rules-generate.js'
import type {
  EvidenceSnapshot,
  GenerationWorkerRequest,
} from './generation-controller.js'
import { isRunCancelledError } from '../../core/src/abort.js'

if (!parentPort) throw new Error('Generation worker requires a parent port')

const port = parentPort
const request = workerData as GenerationWorkerRequest
const abortController = new AbortController()
let evidenceSnapshot: EvidenceSnapshot | undefined
let pendingAssistantText = ''
let assistantFlushTimer: ReturnType<typeof setTimeout> | undefined

function flushAssistantText(): void {
  if (assistantFlushTimer) clearTimeout(assistantFlushTimer)
  assistantFlushTimer = undefined
  if (!pendingAssistantText) return
  port.postMessage({
    type: 'event',
    event: { kind: 'assistant_delta', text: pendingAssistantText },
  })
  pendingAssistantText = ''
}

function queueAssistantText(text: string): void {
  pendingAssistantText += text
  if (assistantFlushTimer) return
  assistantFlushTimer = setTimeout(flushAssistantText, 32)
}

function startRunMetadata(): void {
  const db = new Database(getDbPath())
  try {
    db.prepare(`
      INSERT INTO run_metadata (id, run_type, started_at, status, details)
      VALUES (?, 'generate-rules', ?, 'running', ?)
    `).run(
      request.runId,
      new Date().toISOString(),
      JSON.stringify({ request }),
    )
  } finally {
    db.close()
  }
}

function finishRunMetadata(
  status: 'completed' | 'cancelled' | 'failed',
  details: Record<string, unknown>,
): void {
  const db = new Database(getDbPath())
  try {
    db.prepare(`
      UPDATE run_metadata
      SET ended_at = ?, status = ?, details = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      status,
      JSON.stringify({
        request,
        evidence: evidenceSnapshot
          ? {
              mode: evidenceSnapshot.mode,
              rounds: evidenceSnapshot.rounds,
            projectCount: evidenceSnapshot.projects.length,
            totalSessions: evidenceSnapshot.totalSessions,
            projects: evidenceSnapshot.projects,
            createdAt: evidenceSnapshot.createdAt,
            }
          : null,
        ...details,
      }),
      request.runId,
    )
  } catch (error) {
    console.warn(
      `Unable to finish generation run metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  } finally {
    db.close()
  }
}

port.on('message', (message: unknown) => {
  if (
    message
    && typeof message === 'object'
    && 'type' in message
    && message.type === 'cancel'
  ) {
    abortController.abort()
  }
})

void (async () => {
  try {
    startRunMetadata()
    const options =
      request.mode === 'projects'
        ? { projectSlugs: request.projects }
        : request.mode === 'full'
          ? { full: true }
          : request.mode === 'changed7d'
            ? {
                updatedSince: new Date(
                  Date.now() - 7 * 24 * 60 * 60 * 1_000,
                ).toISOString(),
              }
            : {}
    let result: GenerateProgress = { phase: 'done', candidateCount: 0 }

    await runRulesGenerate({
      ...options,
      runId: request.runId,
      provider: request.provider,
      effort: request.effort,
      fastMode: request.fastMode,
      signal: abortController.signal,
      onEvidence: (bundles) => {
        const snapshot: EvidenceSnapshot = {
          mode: request.mode,
          projects: bundles.map((bundle) => ({
            slug: bundle.projectSlug,
            sessionIds: [...bundle.sourceSessions],
            roundCount: bundle.roundCount,
            excerptCount: bundle.excerpts.length,
          })),
          totalSessions: new Set(
            bundles.flatMap((bundle) => bundle.sourceSessions),
          ).size,
          createdAt: new Date().toISOString(),
        }
        evidenceSnapshot = snapshot
        port.postMessage({
          type: 'event',
          event: { kind: 'evidence_ready', snapshot },
        })
      },
      onLlmEvent: (event) => {
        if (event.type === 'assistant_delta') {
          queueAssistantText(event.text)
          return
        }
        flushAssistantText()
        if (event.type === 'activity') {
          port.postMessage({
            type: 'event',
            event: { kind: 'activity', activity: event.activity },
          })
          return
        }
        port.postMessage({
          type: 'event',
          event: { kind: 'retry', message: event.message },
        })
      },
      onProjectResponse: (response) => {
        flushAssistantText()
        port.postMessage({
          type: 'event',
          event: { kind: 'project_response', response },
        })
      },
      onProgress: (progress) => {
        flushAssistantText()
        result = progress
        port.postMessage({ type: 'progress', progress })
      },
    })

    flushAssistantText()
    finishRunMetadata('completed', {
      candidateCount: result.candidateCount ?? 0,
      failedProjectCount: result.failedProjectCount ?? 0,
    })
    port.postMessage({ type: 'done', result })
  } catch (error) {
    flushAssistantText()
    if (isRunCancelledError(error) || abortController.signal.aborted) {
      finishRunMetadata('cancelled', {})
      port.postMessage({ type: 'cancelled' })
    } else {
      finishRunMetadata('failed', {
        failure: error instanceof Error ? error.message : String(error),
      })
      port.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  } finally {
    if (assistantFlushTimer) clearTimeout(assistantFlushTimer)
    port.close()
  }
})()
