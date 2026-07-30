import { EventEmitter } from 'node:events'
import { describe, expect, it, jest } from '@jest/globals'
import {
  ProviderController,
  type ProviderWorkerLike,
} from '../main/provider-controller.js'

class FakeWorker extends EventEmitter implements ProviderWorkerLike {
  postMessage = jest.fn()
  terminate = jest.fn<() => Promise<number>>().mockResolvedValue(0)
}

describe('ProviderController', () => {
  it('refresh 立即返回并保留最后成功 snapshot', () => {
    const worker = new FakeWorker()
    const events: unknown[] = []
    const controller = new ProviderController(() => worker, (event: unknown) => events.push(event))

    expect(controller.refresh()).toEqual({ started: true })
    expect(controller.snapshot()).toMatchObject({ refreshing: true })

    worker.emit('message', {
      type: 'done',
      entries: [
        {
          id: 'claude',
          label: 'Claude',
          status: 'available',
          enabled: true,
          isDefault: true,
          models: [{ id: 'sonnet', label: 'Sonnet', source: 'discovered' }],
          fetchedAt: '2026-07-29T00:00:00.000Z',
        },
      ],
    })
    expect(controller.snapshot()).toMatchObject({
      refreshing: false,
      entries: [{ id: 'claude', status: 'available', models: [{ id: 'sonnet' }] }],
    })
    expect(events).toContainEqual(expect.objectContaining({ type: 'updated' }))

    const next = new FakeWorker()
    controller.setWorkerFactory(() => next)
    controller.refresh('claude')
    expect(controller.snapshot()).toMatchObject({
      refreshing: true,
      entries: [{ id: 'claude', models: [{ id: 'sonnet' }] }],
    })
  })

  it('运行中拒绝重复 refresh，失败后释放互斥并保留缓存', () => {
    const worker = new FakeWorker()
    const controller = new ProviderController(() => worker, () => undefined)

    expect(controller.refresh()).toEqual({ started: true })
    expect(controller.refresh()).toEqual({ started: false, reason: 'already-refreshing' })
    worker.emit('error', new Error('probe failed'))
    expect(controller.snapshot()).toMatchObject({
      refreshing: false,
      error: 'probe failed',
    })
  })

  it('diagnostic 在 Worker 中运行并缓存脱敏结果', () => {
    const worker = new FakeWorker()
    const events: unknown[] = []
    const controller = new ProviderController(() => worker, (event: unknown) => events.push(event))

    expect(controller.diagnose('codex')).toEqual({ started: true })
    expect(controller.snapshot()).toMatchObject({ diagnosing: 'codex' })
    worker.emit('message', {
      type: 'diagnostic',
      diagnostic: {
        provider: 'codex',
        checkedAt: '2026-07-29T00:00:00.000Z',
        executable: { available: true, version: 'codex 1' },
        authenticated: true,
        catalog: { ok: true, modelCount: 5 },
        text: 'safe diagnostic',
      },
    })
    expect(controller.snapshot()).toMatchObject({
      diagnosing: undefined,
      diagnostics: { codex: { text: 'safe diagnostic' } },
    })
    expect(events).toContainEqual(expect.objectContaining({ type: 'diagnostic' }))
  })
})
