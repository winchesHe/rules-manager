import fs from 'node:fs'
import { describe, expect, it } from '@jest/globals'
import {
  CODEX_TEXT_ATTACHMENT_THRESHOLD,
  prepareSessionContextInput,
} from '../main/session-context-input.js'

describe('prepareSessionContextInput', () => {
  it('Codex 在 5,000 字符边界把隐藏上下文转成临时 mention 并可清理', async () => {
    const contextPrompt = 'x'.repeat(CODEX_TEXT_ATTACHMENT_THRESHOLD)
    const prepared = await prepareSessionContextInput({
      provider: 'codex', message: '执行任务', contextPrompt, revision: 7,
    })
    const mention = prepared.mentions?.[0]

    expect(prepared.message).toContain('host_session_context_attachment')
    expect(prepared.message).toContain('执行任务')
    expect(prepared.message).not.toContain(contextPrompt)
    expect(mention).toMatchObject({ name: 'session-context-r7.txt' })
    expect(fs.readFileSync(mention!.path, 'utf8')).toBe(contextPrompt)
    expect(fs.statSync(mention!.path).mode & 0o777).toBe(0o600)

    await prepared.cleanup()
    expect(fs.existsSync(mention!.path)).toBe(false)
  })

  it('Codex 小于 5,000 字符与 Claude 大型上下文继续内联', async () => {
    const codexPrompt = 'c'.repeat(CODEX_TEXT_ATTACHMENT_THRESHOLD - 1)
    const codex = await prepareSessionContextInput({
      provider: 'codex', message: 'codex', contextPrompt: codexPrompt, revision: 1,
    })
    expect(codex.mentions).toBeUndefined()
    expect(codex.message).toBe(`${codexPrompt}\n\ncodex`)

    const claudePrompt = 'a'.repeat(CODEX_TEXT_ATTACHMENT_THRESHOLD + 1)
    const claude = await prepareSessionContextInput({
      provider: 'claude', message: 'claude', contextPrompt: claudePrompt, revision: 1,
    })
    expect(claude.mentions).toBeUndefined()
    expect(claude.message).toBe(`${claudePrompt}\n\nclaude`)
  })
})
