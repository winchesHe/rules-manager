import { containsSecret, redactSecrets } from '../../src/redaction'

describe('redactSecrets', () => {
  it('清理 Bearer、sk-、token、password 和 API_KEY', () => {
    const input = 'Bearer abc.def sk-secret123 token=hello password: world API_KEY=my-key'
    const output = redactSecrets(input)

    expect(output).toBe('[REDACTED] [REDACTED] token=[REDACTED] password=[REDACTED] API_KEY=[REDACTED]')
    expect(containsSecret(output)).toBe(false)
  })

  it('保留普通规则文本', () => {
    expect(redactSecrets('Always run npm test before commit.')).toBe('Always run npm test before commit.')
  })
})
