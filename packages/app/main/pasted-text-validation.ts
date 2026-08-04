export const MAX_PASTED_TEXT_ATTACHMENTS = 8
export const MAX_PASTED_TEXT_ATTACHMENT_BYTES = 10 * 1024 * 1024

export interface NativePastedTextAttachment {
  name: string
  text: string
  characterCount: number
}

export function validatePastedTextAttachments(value: unknown): NativePastedTextAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_PASTED_TEXT_ATTACHMENTS) {
    throw new Error(`pasted text attachments must be an array of at most ${MAX_PASTED_TEXT_ATTACHMENTS} items`)
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('pasted text attachment is invalid')
    }
    const attachment = item as Record<string, unknown>
    if (typeof attachment.text !== 'string' || attachment.text.length < 5_000) {
      throw new Error('pasted text attachment must contain at least 5000 characters')
    }
    if (Buffer.byteLength(attachment.text, 'utf8') > MAX_PASTED_TEXT_ATTACHMENT_BYTES) {
      throw new Error('pasted text attachment exceeds 10 MiB')
    }
    const name = typeof attachment.name === 'string' && attachment.name.trim()
      ? attachment.name.trim().slice(0, 120)
      : `Pasted text ${index + 1}.txt`
    return { name, text: attachment.text, characterCount: attachment.text.length }
  })
}
