import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { NativeChatProvider } from './chat-store.js'
import type { NativeTurnMention } from './chat-runtime.js'

// Codex Desktop converts pasted text to an attachment at 5,000 JS characters.
export const CODEX_TEXT_ATTACHMENT_THRESHOLD = 5_000

export interface PreparedSessionContextInput {
  message: string
  mentions?: NativeTurnMention[]
  cleanup(): Promise<void>
}

export async function prepareSessionContextInput(input: {
  provider: NativeChatProvider
  message: string
  contextPrompt: string | null
  revision: number
}): Promise<PreparedSessionContextInput> {
  if (!input.contextPrompt) return inlineInput(input.message)
  if (
    input.provider !== 'codex'
    || input.contextPrompt.length < CODEX_TEXT_ATTACHMENT_THRESHOLD
  ) {
    return inlineInput(`${input.contextPrompt}\n\n${input.message}`)
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rules-manager-session-context-'))
  const name = `session-context-r${input.revision}.txt`
  const attachmentPath = path.join(directory, name)
  try {
    await fs.writeFile(attachmentPath, input.contextPrompt, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }

  return {
    message: [
      `<host_session_context_attachment version="1" revision="${input.revision}">`,
      `  <file name="${name}" />`,
      '  <instruction>Read the attached Session Context file and apply its complete replace selection before executing the user request.</instruction>',
      '</host_session_context_attachment>',
      '',
      input.message,
    ].join('\n'),
    mentions: [{ name, path: attachmentPath }],
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  }
}

function inlineInput(message: string): PreparedSessionContextInput {
  return {
    message,
    cleanup: async () => undefined,
  }
}
