import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { NativeChatProvider } from './chat-store.js'
import type { NativeTurnMention } from './chat-runtime.js'
import type { NativePastedTextAttachment } from './pasted-text-validation.js'

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
  pastedTextAttachments?: NativePastedTextAttachment[]
}): Promise<PreparedSessionContextInput> {
  const pastedTextAttachments = input.pastedTextAttachments ?? []
  const contextAsAttachment = Boolean(
    input.contextPrompt
    && input.provider === 'codex'
    && input.contextPrompt.length >= CODEX_TEXT_ATTACHMENT_THRESHOLD,
  )
  if (!contextAsAttachment && pastedTextAttachments.length === 0) {
    return inlineInput(input.contextPrompt
      ? `${input.contextPrompt}\n\n${input.message}`
      : input.message)
  }
  if (pastedTextAttachments.length > 0 && input.provider !== 'codex') {
    throw new Error('pasted text attachments require Codex')
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rules-manager-session-context-'))
  const mentions: NativeTurnMention[] = []
  const messageParts: string[] = []
  try {
    if (contextAsAttachment && input.contextPrompt) {
      const name = `session-context-r${input.revision}.txt`
      const attachmentPath = path.join(directory, name)
      await writePrivateTextFile(attachmentPath, input.contextPrompt)
      mentions.push({ name, path: attachmentPath })
      messageParts.push(
        `<host_session_context_attachment version="1" revision="${input.revision}">`,
        `  <file name="${name}" />`,
        '  <instruction>Read the attached Session Context file and apply its complete replace selection before executing the user request.</instruction>',
        '</host_session_context_attachment>',
      )
    } else if (input.contextPrompt) {
      messageParts.push(input.contextPrompt)
    }
    if (pastedTextAttachments.length > 0) {
      for (const [index, attachment] of pastedTextAttachments.entries()) {
        const attachmentPath = path.join(directory, `pasted-text-${index + 1}.txt`)
        await writePrivateTextFile(attachmentPath, attachment.text)
        mentions.push({ name: attachment.name, path: attachmentPath })
      }
      messageParts.push(
        'The attached pasted text file(s) contain the user request. Read and act on that content.',
      )
    }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
  if (input.message) messageParts.push(input.message)

  return {
    message: messageParts.join('\n\n'),
    mentions,
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  }
}

function writePrivateTextFile(filePath: string, content: string): Promise<void> {
  return fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 })
}

function inlineInput(message: string): PreparedSessionContextInput {
  return {
    message,
    cleanup: async () => undefined,
  }
}
