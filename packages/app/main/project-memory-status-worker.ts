import { parentPort, workerData } from 'node:worker_threads'
import { inspectCodexProjectMemoryPublication } from '../../core/src/codex-project-memory-publish.js'
import { inspectClaudeProjectMemoryPublication } from '../../core/src/project-memory-publish.js'

if (!parentPort) throw new Error('Project memory status worker requires a parent port')

const port = parentPort
const projectSlug = typeof workerData?.projectSlug === 'string' ? workerData.projectSlug : ''

try {
  const [claude, codex] = await Promise.all([
    Promise.resolve(inspectClaudeProjectMemoryPublication(projectSlug)),
    inspectCodexProjectMemoryPublication(projectSlug),
  ])
  port.postMessage({ type: 'done', status: { projectSlug, claude, codex } })
} catch (error) {
  port.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
} finally {
  port.close()
}
