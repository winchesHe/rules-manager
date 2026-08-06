import { describe, expect, it } from '@jest/globals'
import { rulesGenerationCoreBridge } from '../main/native-chat-controller.js'

describe('rulesGenerationCoreBridge', () => {
  it('仅把 OpenCode 映射到 Core 编排合同，并保留可审计模型标识', () => {
    expect(rulesGenerationCoreBridge('opencode', undefined)).toEqual({
      provider: 'codex',
      model: 'opencode:default',
    })
    expect(rulesGenerationCoreBridge('opencode', 'openai/gpt-test')).toEqual({
      provider: 'codex',
      model: 'openai/gpt-test',
    })
  })

  it('不允许 Pi 进入 Rules 编排', () => {
    expect(() => rulesGenerationCoreBridge('pi', undefined)).toThrow('Pi 不支持规则生成')
  })
})
