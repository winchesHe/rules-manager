import { mkdirSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { resolveWorkspace } from '@memory-manager/core/workspace'
import { runScan } from '../../core/src/scanner.js'
import type { AgentName } from '../../core/src/types.js'
import { isRunCancelledError } from '../../core/src/abort.js'

if (!parentPort) throw new Error('Scan worker requires a parent port')

const port = parentPort
const runId = typeof workerData?.runId === 'string' ? workerData.runId : undefined
const selectedAgents = Array.isArray(workerData?.agents)
  ? (workerData.agents as AgentName[])
  : []
const sinceDays =
  typeof workerData?.sinceDays === 'number' ? workerData.sinceDays : undefined
const abortController = new AbortController()

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
    mkdirSync(resolveWorkspace().workspaceDir, { recursive: true })
    const summary = await runScan({
      ...(selectedAgents.length > 0 ? { agents: selectedAgents } : { all: true }),
      runId,
      sinceDays,
      signal: abortController.signal,
      onProgress: (progress) => port.postMessage({ type: 'progress', progress }),
    })
    port.postMessage({ type: 'done', summary })
  } catch (error) {
    if (isRunCancelledError(error) || abortController.signal.aborted) {
      port.postMessage({ type: 'cancelled' })
    } else {
      port.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  } finally {
    port.close()
  }
})()
