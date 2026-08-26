export const PASTED_TEXT_ATTACHMENT_THRESHOLD = 5_000
export const PASTED_TEXT_RESTORE_LIMIT = 25_000

export interface ComposerTextAttachment {
  id: string
  name: string
  text: string
  characterCount: number
}

export function createComposerTextAttachment(
  text: string,
  id: string,
): ComposerTextAttachment | null {
  if (text.length < PASTED_TEXT_ATTACHMENT_THRESHOLD) return null
  return {
    id,
    name: 'Pasted text.txt',
    text,
    characterCount: text.length,
  }
}
