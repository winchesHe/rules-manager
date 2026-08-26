import { describe, expect, it } from '@jest/globals'
import {
  createComposerTextAttachment,
  PASTED_TEXT_ATTACHMENT_THRESHOLD,
} from '../renderer/src/views/chat-pasted-text-model.js'

describe('createComposerTextAttachment', () => {
  it('以 Codex Desktop 的 5,000 字符边界转换粘贴文本', () => {
    expect(createComposerTextAttachment(
      'a'.repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD - 1), 'short',
    )).toBeNull()
    expect(createComposerTextAttachment(
      '中'.repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD), 'large',
    )).toMatchObject({
      id: 'large',
      name: 'Pasted text.txt',
      characterCount: PASTED_TEXT_ATTACHMENT_THRESHOLD,
    })
  })
})
