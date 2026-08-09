import { describe, expect, it } from '@jest/globals'
import type { CoverageLedger } from '../../core/src/evidence-coverage.js'
import type { SessionCapsule } from '../../core/src/live-evidence-context.js'
import { NativeEvidenceModelRunner } from '../main/evidence-model-runner.js'
import {
  ChatRuntimeManager,
  type ChatProviderAdapter,
  type NativeTurnRequest,
} from '../main/chat-runtime.js'

describe('NativeEvidenceModelRunner', () => {
  it('Map 使用隔离 start，Reduce 使用当前 Chat resume 并保留 Native handle', async () => {
    const requests: NativeTurnRequest[] = []
    const closed: string[] = []
    const capsule: SessionCapsule = {
      sessionId: 'session-1',
      agent: 'codex',
      chunkIndex: 0,
      chunkCount: 1,
      summary: 'summary',
      facts: [{
        id: 'fact-1', text: 'fact', kind: 'explicit',
        locators: [{
          sessionId: 'session-1', agent: 'codex', messageIndex: 0, sourceRevision: 'revision-1',
        }],
      }],
      relevant: true,
    }
    const runtime = new ChatRuntimeManager((_provider, chatId): ChatProviderAdapter => ({
      start: async (request) => {
        requests.push(request)
        if (request.message.includes('中间 Reduce job')) {
          return {
            nativeSessionId: 'reduce-batch-native',
            content: '',
            structuredOutput: { summary: 'reduced summary', evidenceFactIds: ['fact-1'] },
          }
        }
        return {
          nativeSessionId: 'map-native',
          content: '',
          structuredOutput: capsule,
        }
      },
      resume: async (request) => {
        requests.push(request)
        return {
          nativeSessionId: request.nativeSessionId,
          nativeSessionHandle: { sessionId: request.nativeSessionId, nativeHandle: 'handle-next' },
          content: '',
          structuredOutput: {
            answerMarkdown: 'answer',
            claims: [{ text: 'fact', evidenceFactIds: ['fact-1'] }],
            limitations: [],
          },
        }
      },
      interrupt: async () => undefined,
      readToolItem: async () => ({ available: false, content: '', nextCursor: null }),
      archive: async () => undefined,
      unarchive: async () => undefined,
      delete: async () => undefined,
      close: async () => { closed.push(chatId) },
    }))
    const reduceResults: string[] = []
    const runner = new NativeEvidenceModelRunner({
      runtime,
      provider: 'codex',
      workingDirectory: '/workspace',
      config: { effort: 'medium', fastMode: false },
      onReduceResult: (result) => reduceResults.push(result.nativeSessionHandle?.nativeHandle ?? ''),
    })

    const mapped = await runner.runMap({
      runId: 'run-1', question: 'question', sessionId: 'session-1', agent: 'codex',
      chunkIndex: 0, chunkCount: 1, chunkPath: '/tmp/chunk.md', sourceRevision: 'revision-1',
    })
    const reduced = await runner.runReduceBatch({
      runId: 'run-1', question: 'question', level: 0, batchIndex: 0, batchCount: 1,
      evidence: [{ kind: 'capsule', capsule: mapped }],
    })
    const coverage = {
      runId: 'run-1', mode: 'complete', status: 'complete', selected: 1, visited: 1,
      readable: 1, empty: 0, unavailable: 0, readFailed: 0, processed: 1,
      processFailed: 0, relevant: 1, changedDuringRun: 0,
      rows: [{
        sessionId: 'session-1', agent: 'codex', selected: true, visited: true,
        sourceStatus: 'readable', processingStatus: 'processed', relevant: true,
        messageCount: 1, errorMessage: '/secret/local/source/path',
      }],
    } satisfies CoverageLedger
    const synthesis = await runner.runReduce({
      runId: 'run-1', question: 'question', mode: 'complete',
      currentChat: { chatId: 'chat-current', nativeSessionId: 'native-current', nativeHandle: 'handle-current' },
      evidence: [{ kind: 'batch', batch: reduced }], coverage,
    })

    expect(synthesis.answerMarkdown).toBe('answer')
    expect(requests).toHaveLength(3)
    expect(requests[0]).toMatchObject({
      chatId: expect.stringMatching(/^run-1:map:[a-f0-9]{16}$/),
      mentions: [{ path: '/tmp/chunk.md' }],
      outputSchema: expect.any(Object),
    })
    expect(requests[0]).not.toHaveProperty('nativeSessionId')
    expect(requests[0].message).toContain('[memory-manager:live-evidence-map]')
    expect(requests[1]).toMatchObject({
      chatId: expect.stringMatching(/^run-1:reduce-batch:[a-f0-9]{16}$/),
      outputSchema: expect.any(Object),
    })
    expect(requests[1]).not.toHaveProperty('nativeSessionId')
    expect(requests[1].message).toContain('中间 Reduce job')
    expect(requests[2]).toMatchObject({
      chatId: 'chat-current',
      nativeSessionId: 'native-current',
      nativeSessionHandle: { sessionId: 'native-current', nativeHandle: 'handle-current' },
      outputSchema: expect.any(Object),
    })
    expect(requests[2].message).toContain('[memory-manager:live-evidence-reduce]')
    expect(requests[2].message).toContain('"kind":"batch"')
    expect(requests[2].message).not.toContain('/secret/local/source/path')
    expect(closed).toEqual([
      expect.stringMatching(/^run-1:map:[a-f0-9]{16}$/),
      expect.stringMatching(/^run-1:reduce-batch:[a-f0-9]{16}$/),
    ])
    expect(reduceResults).toEqual(['handle-next'])
  })
})
