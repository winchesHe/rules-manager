import { EventEmitter } from 'node:events'
import { describe, expect, it, jest } from '@jest/globals'
import { ScanController, type ScanWorkerLike } from '../main/scan-controller.js'

class FakeWorker extends EventEmitter implements ScanWorkerLike {
  postMessage = jest.fn<(message: { type: 'cancel' }) => void>()
  terminate = jest.fn<() => Promise<number>>().mockResolvedValue(0)
}

describe('ScanController', () => {
  it('把用户选择的 agents 和时间窗口传给 Worker factory', () => {
    const worker = new FakeWorker()
    const factory = jest.fn(() => worker)
    const controller = new ScanController(factory, () => undefined)

    const result = controller.start(['codex', 'pi'], 7)
    expect(result).toEqual({ started: true, runId: expect.any(String) })
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      agents: ['codex', 'pi'],
      sinceDays: 7,
      runId: result.started ? result.runId : undefined,
    }))
    expect(controller.status()).toMatchObject({
      runId: result.started ? result.runId : undefined,
      state: 'running',
      selectedAgents: ['codex', 'pi'],
      sinceDays: 7,
    })
  })

  it('start 立即返回，完成结果通过后台事件送达', async () => {
    const worker = new FakeWorker()
    const events: unknown[] = []
    const controller = new ScanController(() => worker, (event: unknown) => events.push(event))

    expect(controller.start()).toEqual({ started: true, runId: expect.any(String) })
    expect(controller.status()).toMatchObject({ running: true, state: 'running' })

    worker.emit('message', {
      type: 'progress',
      progress: { agent: 'codex', phase: 'processing', current: 1, total: 2 },
    })
    expect(controller.status()).toMatchObject({
      running: true,
      progress: { agent: 'codex', current: 1, total: 2 },
      progressByAgent: {
        codex: { agent: 'codex', phase: 'processing', current: 1, total: 2 },
      },
    })

    worker.emit('message', {
      type: 'progress',
      progress: { agent: 'codex', phase: 'done', current: 2, total: 2 },
    })
    worker.emit('message', {
      type: 'done',
      summary: { total: 2, new: 1, updated: 0, unchanged: 1, missing: 0, errors: 0 },
    })
    expect(controller.status()).toMatchObject({
      running: false,
      state: 'completed',
      summary: { total: 2, new: 1 },
      progressByAgent: {
        codex: { agent: 'codex', phase: 'done', current: 2, total: 2 },
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'done',
        runId: expect.any(String),
        seq: expect.any(Number),
        summary: expect.objectContaining({ total: 2 }),
      }),
    )
  })

  it('运行中拒绝启动第二个 worker，失败后释放互斥', () => {
    const first = new FakeWorker()
    const second = new FakeWorker()
    const factory = jest
      .fn<() => ScanWorkerLike>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const controller = new ScanController(factory, () => undefined)

    expect(controller.start()).toEqual({ started: true, runId: expect.any(String) })
    expect(controller.start()).toEqual({ started: false, reason: 'already-running' })
    expect(factory).toHaveBeenCalledTimes(1)

    first.emit('error', new Error('boom'))
    expect(controller.status()).toMatchObject({ running: false, error: 'boom' })
    expect(controller.start()).toEqual({ started: true, runId: expect.any(String) })
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('worker 未发送 done 就退出时报告失败', () => {
    const worker = new FakeWorker()
    const controller = new ScanController(() => worker, () => undefined)

    controller.start()
    worker.emit('exit', 3)

    expect(controller.status()).toMatchObject({
      running: false,
      state: 'failed',
      error: 'Scan worker exited before completion (code 3)',
    })
  })

  it('按 runId 协作取消，并把用户取消与失败区分开', () => {
    const worker = new FakeWorker()
    const events: unknown[] = []
    const controller = new ScanController(
      () => worker,
      (event: unknown) => events.push(event),
    )
    const started = controller.start(['codex'])
    if (!started.started) throw new Error('scan should start')

    expect(controller.cancel('stale-run')).toEqual({
      accepted: false,
      reason: 'stale-run',
    })
    expect(controller.cancel(started.runId)).toEqual({ accepted: true })
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'cancel' })
    expect(controller.status()).toMatchObject({
      runId: started.runId,
      running: true,
      state: 'cancelling',
    })
    expect(controller.start(['pi'])).toEqual({
      started: false,
      reason: 'already-running',
    })

    worker.emit('message', {
      type: 'cancelled',
      summary: { total: 1, new: 1, updated: 0, unchanged: 0, missing: 0, errors: 0 },
    })

    expect(controller.status()).toMatchObject({
      runId: started.runId,
      running: false,
      state: 'cancelled',
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'cancelled',
      runId: started.runId,
      seq: expect.any(Number),
    }))
  })

  it('可等待扫描完成并复用相同范围的活跃 Worker', async () => {
    const worker = new FakeWorker()
    const factory = jest.fn(() => worker)
    const controller = new ScanController(factory, () => undefined)
    controller.start([], 7)

    const completed = controller.runToCompletion([], 7)
    expect(factory).toHaveBeenCalledTimes(1)
    worker.emit('message', {
      type: 'done',
      summary: { total: 3, new: 1, updated: 1, unchanged: 1, missing: 0, errors: 0 },
    })

    await expect(completed).resolves.toMatchObject({ total: 3, new: 1 })
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('已有其他范围扫描时串行执行生成所需范围', async () => {
    const first = new FakeWorker()
    const second = new FakeWorker()
    const factory = jest
      .fn<() => ScanWorkerLike>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const controller = new ScanController(factory, () => undefined)
    controller.start(['codex'], 1)

    const completed = controller.runToCompletion([], 7)
    first.emit('message', {
      type: 'done',
      summary: { total: 1, new: 0, updated: 0, unchanged: 1, missing: 0, errors: 0 },
    })
    await Promise.resolve()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenLastCalledWith(expect.objectContaining({ agents: [], sinceDays: 7 }))
    second.emit('message', {
      type: 'done',
      summary: { total: 2, new: 1, updated: 1, unchanged: 0, missing: 0, errors: 0 },
    })

    await expect(completed).resolves.toMatchObject({ total: 2 })
  })

  it('可等待入口透传扫描失败与取消', async () => {
    const failedWorker = new FakeWorker()
    const cancelledWorker = new FakeWorker()
    const controller = new ScanController(
      jest.fn<() => ScanWorkerLike>()
        .mockReturnValueOnce(failedWorker)
        .mockReturnValueOnce(cancelledWorker),
      () => undefined,
    )

    const failed = controller.runToCompletion([], 7)
    failedWorker.emit('error', new Error('scan boom'))
    await expect(failed).rejects.toThrow('scan boom')

    const cancelled = controller.runToCompletion([], 7)
    const active = controller.status()
    if (!active.runId) throw new Error('scan should be active')
    controller.cancel(active.runId)
    cancelledWorker.emit('message', { type: 'cancelled' })
    await expect(cancelled).rejects.toThrow('扫描已取消')
  })
})
