import { parentPort, workerData } from 'node:worker_threads'
import { readSessionPreview } from '../../core/src/evidence.js'

if (!parentPort) throw new Error('Session preview worker requires a parent port')

const port = parentPort
const sessionId = typeof workerData?.sessionId === 'string'
  ? workerData.sessionId
  : ''

void (async () => {
  try {
    const preview = await readSessionPreview(sessionId)
    port.postMessage({ type: 'done', preview })
  } catch (error) {
    port.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    port.close()
  }
})()
