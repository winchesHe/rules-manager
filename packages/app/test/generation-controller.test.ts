import { EventEmitter } from 'node:events'
import { describe, expect, it, jest } from '@jest/globals'
import {
  GenerationController,
  type GenerationRequest,
  type GenerationWorkerLike,
} from '../main/generation-controller.js'

class FakeWorker extends EventEmitter implements GenerationWorkerLike {
  postMessage = jest.fn<(message: { type: 'cancel' }) => void>()
  terminate = jest.fn<() => Promise<number>>().mockResolvedValue(0)
}

describe('GenerationController', () => {
  it('start 立即返回，并把生成范围交给 Worker', () => {
    const worker = new FakeWorker()
    const factory = jest.fn(() => worker)
    const controller = new GenerationController(factory, () => undefined)
    const request: GenerationRequest = { mode: 'changed7d', projects: [] }

    const result = controller.start(request)
    expect(result).toEqual({ started: true, runId: expect.any(String) })
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      ...request,
      runId: result.started ? result.runId : undefined,
    }))
    expect(controller.status()).toMatchObject({
      runId: result.started ? result.runId : undefined,
      running: true,
      state: 'running',
      request,
    })
  })

  it('通过后台消息更新进度和完成状态', () => {
    const worker = new FakeWorker()
    const events: unknown[] = []
    const controller = new GenerationController(
      () => worker,
      (event: unknown) => events.push(event),
    )

    controller.start({ mode: 'recent', projects: [] })
    worker.emit('message', {
      type: 'progress',
      progress: {
        phase: 'generating',
        current: 1,
        total: 2,
        projectSlug: 'demo',
      },
    })
    expect(controller.status()).toMatchObject({
      running: true,
      progress: { phase: 'generating', current: 1, total: 2 },
    })

    worker.emit('message', {
      type: 'done',
      result: { phase: 'done', candidateCount: 3 },
    })
    expect(controller.status()).toMatchObject({
      running: false,
      state: 'completed',
      progress: { phase: 'done', candidateCount: 3 },
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done',
      runId: expect.any(String),
      seq: expect.any(Number),
      result: { phase: 'done', candidateCount: 3 },
    }))
  })

  it('运行中拒绝第二次启动，Worker 异常后释放互斥', () => {
    const first = new FakeWorker()
    const second = new FakeWorker()
    const factory = jest
      .fn<() => GenerationWorkerLike>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const controller = new GenerationController(factory, () => undefined)

    expect(controller.start({ mode: 'full', projects: [] })).toEqual({
      started: true,
      runId: expect.any(String),
    })
    expect(controller.start({ mode: 'recent', projects: [] })).toEqual({
      started: false,
      reason: 'already-running',
    })
    expect(factory).toHaveBeenCalledTimes(1)

    first.emit('error', new Error('boom'))
    expect(controller.status()).toMatchObject({ running: false, error: 'boom' })
    expect(controller.start({ mode: 'recent', projects: [] })).toEqual({
      started: true,
      runId: expect.any(String),
    })
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('Worker 未发送完成消息就退出时报告失败', () => {
    const worker = new FakeWorker()
    const controller = new GenerationController(() => worker, () => undefined)

    controller.start({ mode: 'recent', projects: [] })
    worker.emit('exit', 2)

    expect(controller.status()).toMatchObject({
      running: false,
      state: 'failed',
      error: 'Generation worker exited before completion (code 2)',
    })
  })

  it('累积流式输出和 evidence snapshot，status 可供页面重挂载恢复', () => {
    const worker = new FakeWorker()
    const events: unknown[] = []
    const controller = new GenerationController(
      () => worker,
      (event: unknown) => events.push(event),
    )
    const started = controller.start({ mode: 'changed7d', projects: [] })
    if (!started.started) throw new Error('generation should start')

    worker.emit('message', {
      type: 'event',
      event: { kind: 'assistant_delta', text: 'first ' },
    })
    worker.emit('message', {
      type: 'event',
      event: { kind: 'assistant_delta', text: 'second' },
    })
    worker.emit('message', {
      type: 'event',
      event: {
        kind: 'evidence_ready',
        snapshot: {
          mode: 'changed7d',
          projects: [{
            slug: 'demo',
            sessionIds: ['session-1'],
            roundCount: 4,
            excerptCount: 4,
          }],
          totalSessions: 1,
          createdAt: '2026-07-29T00:00:00.000Z',
        },
      },
    })

    expect(controller.status()).toMatchObject({
      runId: started.runId,
      state: 'running',
      output: 'first second',
      lastSeq: 3,
      evidence: {
        mode: 'changed7d',
        totalSessions: 1,
      },
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'event',
      runId: started.runId,
      seq: 1,
      event: { kind: 'assistant_delta', text: 'first ' },
    }))
  })

  it('取消时保持互斥，Worker 确认后进入 cancelled 且不报告失败', () => {
    const worker = new FakeWorker()
    const events: unknown[] = []
    const controller = new GenerationController(
      () => worker,
      (event: unknown) => events.push(event),
    )
    const started = controller.start({ mode: 'recent', projects: [] })
    if (!started.started) throw new Error('generation should start')

    expect(controller.cancel('stale-run')).toEqual({
      accepted: false,
      reason: 'stale-run',
    })
    expect(controller.cancel(started.runId)).toEqual({ accepted: true })
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'cancel' })
    expect(controller.status()).toMatchObject({
      state: 'cancelling',
      running: true,
    })

    worker.emit('message', { type: 'cancelled' })
    expect(controller.status()).toMatchObject({
      state: 'cancelled',
      running: false,
      error: undefined,
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'cancelled',
      runId: started.runId,
    }))
  })

  it('按项目完成顺序恢复结构化响应并返回深层 defensive copy', () => {
    const worker = new FakeWorker()
    const controller = new GenerationController(() => worker, () => undefined)
    controller.start({ mode: 'projects', projects: ['first', 'second'] })

    for (const projectSlug of ['first', 'second']) {
      worker.emit('message', {
        type: 'event',
        event: {
          kind: 'project_response',
          response: {
            projectSlug,
            summary: `Generated candidates for ${projectSlug}.`,
            candidates: [{
              rule: `Rule for ${projectSlug}`,
              scope: 'project',
              confidence: 'high',
              reasoning: 'Explicit requirement',
              evidenceRefs: [`${projectSlug}-session:0`],
            }],
          },
        },
      })
    }

    const firstStatus = controller.status()
    expect(firstStatus.projectResponses.map((response) => response.projectSlug))
      .toEqual(['first', 'second'])
    firstStatus.projectResponses[0].candidates[0].evidenceRefs.push('mutated')
    firstStatus.projectResponses[0].candidates[0].reasoning = 'mutated'

    expect(controller.status().projectResponses[0].candidates[0]).toEqual({
      rule: 'Rule for first',
      scope: 'project',
      confidence: 'high',
      reasoning: 'Explicit requirement',
      evidenceRefs: ['first-session:0'],
    })
  })

  it('取消后仍保留取消前已完成项目的内存预览', () => {
    const worker = new FakeWorker()
    const controller = new GenerationController(() => worker, () => undefined)
    const started = controller.start({ mode: 'recent', projects: [] })
    if (!started.started) throw new Error('generation should start')

    worker.emit('message', {
      type: 'event',
      event: {
        kind: 'project_response',
        response: {
          projectSlug: 'demo',
          summary: 'Generated 1 candidate for demo.',
          candidates: [{
            rule: 'Always run tests',
            scope: 'project',
            confidence: 'high',
            reasoning: 'Explicit requirement',
            evidenceRefs: ['s1:0'],
          }],
        },
      },
    })
    controller.cancel(started.runId)
    worker.emit('message', { type: 'cancelled' })

    expect(controller.status()).toMatchObject({
      state: 'cancelled',
      projectResponses: [{
        projectSlug: 'demo',
        candidates: [{ rule: 'Always run tests' }],
      }],
    })
  })
})
