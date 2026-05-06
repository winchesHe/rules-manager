import fs from 'node:fs'
import crypto from 'node:crypto'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}

export function fileHash(filePath: string): string {
  const content = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(content).digest('hex')
}

export function fileMtime(filePath: string): string {
  return fs.statSync(filePath).mtime.toISOString()
}

export function readFirstLine(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf8')
  const newline = content.indexOf('\n')
  return newline === -1 ? content : content.slice(0, newline)
}
