import { parentPort, workerData } from 'node:worker_threads'
import { listProjectSessions } from '@memory-manager/core'

if (!parentPort) throw new Error('Project sessions worker requires a parent port')

const port = parentPort
const slug = typeof workerData?.slug === 'string' ? workerData.slug : ''

try {
  const sessions = listProjectSessions({ slug })
  port.postMessage({ type: 'done', sessions })
} catch (error) {
  port.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
} finally {
  port.close()
}
