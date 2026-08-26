import { describe, expect, it } from '@jest/globals'
import {
  MAX_PASTED_TEXT_ATTACHMENTS,
  validatePastedTextAttachments,
} from '../main/pasted-text-validation.js'

describe('validatePastedTextAttachments', () => {
  it('重新计算字符数并规范附件名称', () => {
    const text = 'x'.repeat(5_000)
    expect(validatePastedTextAttachments([{ name: ' request.txt ', text }])).toEqual([{
      name: 'request.txt', text, characterCount: 5_000,
    }])
  })

  it('限制数量、最小字符数和单附件字节数', () => {
    expect(() => validatePastedTextAttachments(
      Array.from({ length: MAX_PASTED_TEXT_ATTACHMENTS + 1 }, () => ({ text: 'x'.repeat(5_000) })),
    )).toThrow('at most')
    expect(() => validatePastedTextAttachments([{ text: 'short' }])).toThrow('at least 5000')
    expect(() => validatePastedTextAttachments([{ text: '中'.repeat(4 * 1024 * 1024) }]))
      .toThrow('exceeds 10 MiB')
  })
})
