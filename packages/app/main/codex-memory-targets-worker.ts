import { parentPort, workerData } from 'node:worker_threads'
import { listCodexProjectMemoryPublishTargets } from '../../core/src/codex-project-memory-publish.js'

if (!parentPort) throw new Error('Codex memory targets worker requires a parent port')

const port = parentPort
const projectSlug = typeof workerData?.projectSlug === 'string' ? workerData.projectSlug : ''

try {
  const targets = await listCodexProjectMemoryPublishTargets(projectSlug)
  port.postMessage({ type: 'done', targets })
} catch (error) {
  port.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
} finally {
  port.close()
}
