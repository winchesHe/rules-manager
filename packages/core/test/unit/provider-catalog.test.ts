import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadLlmConfig,
  saveLlmConfig,
  type LlmConfig,
} from '../../src/config'
import {
  mergeProviderModels,
  normalizeCustomModel,
  redactDiagnosticText,
} from '../../src/provider-catalog'
import {
  addCustomProviderModel,
  removeCustomProviderModel,
  selectProviderModel,
  setProviderEnabled,
} from '../../src/provider-settings'

describe('provider catalog 与配置兼容', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-provider-catalog-'))
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('旧配置读取后补齐默认 enabled 状态且保持顶层默认项', () => {
    const config = saveLlmConfig(
      { provider: 'codex', model: 'gpt-test', effort: 'high' },
      home,
    )

    expect(config).toEqual({
      provider: 'codex',
      model: 'gpt-test',
      effort: 'high',
      providers: {
        claude: { enabled: true },
        codex: { enabled: true },
      },
    })
    expect(loadLlmConfig(home)).toEqual(config)
  })

  it('拒绝关闭唯一启用或当前默认 Provider', () => {
    const invalid: LlmConfig = {
      provider: 'claude',
      effort: 'medium',
      providers: {
        claude: { enabled: false },
        codex: { enabled: true },
      },
    }
    expect(() => saveLlmConfig(invalid, home)).toThrow('默认 provider 必须启用')
  })

  it('custom model 覆盖 discovered label 并稳定去重', () => {
    expect(
      mergeProviderModels(
        [
          { id: 'same', label: 'Discovered', description: 'runtime', source: 'discovered' },
          { id: 'other', label: 'Other', source: 'discovered' },
        ],
        [
          { id: 'same', label: 'Custom label' },
          { id: 'new-model' },
        ],
      ),
    ).toEqual([
      { id: 'same', label: 'Custom label', description: 'runtime', source: 'custom' },
      { id: 'other', label: 'Other', source: 'discovered' },
      { id: 'new-model', label: 'new-model', source: 'custom' },
    ])
  })

  it('custom model 校验单行、长度和控制字符', () => {
    expect(normalizeCustomModel({ id: ' model-x ', label: ' Label ' })).toEqual({
      id: 'model-x',
      label: 'Label',
    })
    expect(() => normalizeCustomModel({ id: 'bad\nmodel' })).toThrow()
    expect(() => normalizeCustomModel({ id: 'x'.repeat(201) })).toThrow()
  })

  it('diagnostic 脱敏 token、Authorization 和常见 secret', () => {
    const text = redactDiagnosticText(
      'Authorization: Bearer secret-token ANTHROPIC_API_KEY=sk-ant-test access_token="abc"',
    )
    expect(text).not.toContain('secret-token')
    expect(text).not.toContain('sk-ant-test')
    expect(text).not.toContain('"abc"')
    expect(text).toContain('[REDACTED]')
  })

  it('provider mutation 同步 enabled、顶层默认项与 custom models', () => {
    saveLlmConfig({ provider: 'claude', effort: 'medium' }, home)

    expect(setProviderEnabled('codex', false, home).providers?.codex).toEqual({
      enabled: false,
    })
    expect(() => setProviderEnabled('claude', false, home)).toThrow(
      '当前默认 provider 不能禁用',
    )

    addCustomProviderModel('codex', { id: ' custom ', label: 'Custom' }, home)
    const selected = selectProviderModel('codex', 'custom', home)
    expect(selected).toMatchObject({
      provider: 'codex',
      model: 'custom',
      providers: {
        codex: {
          enabled: true,
          additionalModels: [{ id: 'custom', label: 'Custom' }],
        },
      },
    })

    const removed = removeCustomProviderModel('codex', 'custom', home)
    expect(removed.provider).toBe('codex')
    expect(removed.model).toBeUndefined()
    expect(removed.providers?.codex?.additionalModels).toBeUndefined()
  })
})
