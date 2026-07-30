import { parentPort, workerData } from 'node:worker_threads'
import { diagnoseProvider, probeProviders } from './provider-probe.js'
import type { LlmProvider } from '../../core/src/config.js'

if (!parentPort) throw new Error('Provider worker requires a parent port')

const request = workerData as
  | { operation?: 'refresh' | 'diagnostic'; provider?: LlmProvider }
  | undefined
const provider = request?.provider
const port = parentPort

void (request?.operation === 'diagnostic' && provider
  ? diagnoseProvider(provider).then((diagnostic) => ({ type: 'diagnostic', diagnostic }))
  : probeProviders(provider).then((entries) => ({ type: 'done', entries })))
  .then((message) => {
    port.postMessage(message)
  })
  .catch((error) => {
    port.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  })
  .finally(() => port.close())
