import { describe, expect, it } from '@jest/globals'
import { mapAccessibleOpenCodeModels } from '../main/provider-probe.js'

describe('OpenCode provider probe', () => {
  it('只返回 connected 与 source=api Provider 的模型', () => {
    const models = mapAccessibleOpenCodeModels({
      connected: ['codex-pro'],
      all: [
        provider('codex-pro', 'config', ['gpt-5.6-sol', 'gpt-5.6-terra']),
        provider('models-dev-catalog', 'config', ['unavailable-a', 'unavailable-b']),
        provider('opencode', 'api', ['big-pickle']),
      ],
    })

    expect(models.map((model) => model.id)).toEqual([
      'codex-pro/gpt-5.6-sol',
      'codex-pro/gpt-5.6-terra',
      'opencode/big-pickle',
    ])
  })

  it('没有 connected 或 source=api Provider 时拒绝伪装成可用目录', () => {
    expect(() => mapAccessibleOpenCodeModels({
      connected: [],
      all: [provider('models-dev-catalog', 'config', ['unavailable'])],
    })).toThrow('OpenCode 没有已连接的 Provider')
  })
})

function provider(
  id: string,
  source: 'env' | 'config' | 'custom' | 'api',
  modelIds: string[],
) {
  return {
    id,
    name: id,
    source,
    models: Object.fromEntries(modelIds.map((modelId) => [modelId, {
      id: modelId,
      name: modelId,
      variants: modelId.includes('sol') ? { high: {} } : undefined,
    }])),
  }
}
