import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import type {
  DiscoveredSession,
  NormalizedSession,
  ParsedSession,
} from '../types.js'

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

export function collectFilesRecursive(
  root: string,
  predicate: (filePath: string) => boolean,
): string[] {
  if (!fs.existsSync(root)) return []
  const files: string[] = []
  const directories = [root]
  while (directories.length > 0) {
    const directory = directories.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) directories.push(entryPath)
      else if (entry.isFile() && predicate(entryPath)) files.push(entryPath)
    }
  }
  return files.sort()
}

export function readFirstLine(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf8')
  const newline = content.indexOf('\n')
  return newline === -1 ? content : content.slice(0, newline)
}

// 读文件并按行 JSON.parse；非法行静默跳过；文件不存在返回空数组。
// fixture 当前最大 239 行，全量读简单且足够。
export function readJsonlObjects(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return []
  const content = fs.readFileSync(filePath, 'utf8')
  const out: Record<string, unknown>[] = []
  for (const line of content.split('\n')) {
    if (!line) continue
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      out.push(obj)
    } catch {
      // 非 JSON 行：跳过
    }
  }
  return out
}

export function readYamlObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {}
  const value = parseYaml(fs.readFileSync(filePath, 'utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

// 4 adapter 通用：normalize 把 discover + parse 的结果合并成权威值。
// 当前 contentHash / sessionId 仍以 discovered 为权威（已是稳定 UUID + sha256），
// updatedAt 优先采用 parsed.lastTimestamp（来自内嵌时间戳更可靠）。
export async function defaultNormalize(
  parsed: ParsedSession,
  discovered: DiscoveredSession,
): Promise<NormalizedSession> {
  return {
    sessionId: discovered.id,
    agent: discovered.agent,
    sourcePath: discovered.sourcePath,
    sourceKind: discovered.sourceKind,
    updatedAt: parsed.lastTimestamp ?? discovered.updatedAt,
    contentHash: discovered.contentHash,
    parsed,
  }
}
