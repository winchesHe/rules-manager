import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EvidenceBundle, EvidenceExcerpt } from './evidence.js'

const CONTEXT_PREFIX = 'memory-manager-evidence-'
const DEFAULT_MAX_BATCH_BYTES = 512 * 1024
const COMPLETE_READ_MAX_BYTES = 128 * 1024
const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1_000

export type EvidenceReadingStrategy = 'complete' | 'selective'

export interface EvidenceProjectContext {
  projectSlug: string
  directory: string
  manifestPath: string
  baselinePath: string
  outputSchemaPath: string
  batchCount: number
  readingStrategy: EvidenceReadingStrategy
  totalBatchBytes: number
}

export interface EvidenceContext {
  rootDir: string
  projects: EvidenceProjectContext[]
  cleanup: () => void
}

export interface EvidenceContextOptions {
  parentDir?: string
  maxBatchBytes?: number
}

export interface CleanupEvidenceContextOptions {
  parentDir?: string
  now?: number
  maxAgeMs?: number
}

export function createEvidenceContext(
  bundles: EvidenceBundle[],
  options: EvidenceContextOptions = {},
): EvidenceContext {
  const parentDir = options.parentDir ?? os.tmpdir()
  const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
  if (!Number.isInteger(maxBatchBytes) || maxBatchBytes <= 0) {
    throw new Error('Evidence batch byte budget must be a positive integer')
  }
  fs.mkdirSync(parentDir, { recursive: true })
  const rootDir = fs.mkdtempSync(
    path.join(parentDir, `${CONTEXT_PREFIX}${process.pid}-`),
  )
  fs.chmodSync(rootDir, 0o700)

  try {
    const projects = bundles.map((bundle, index) =>
      writeProjectContext(rootDir, bundle, index, maxBatchBytes))
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      process.removeListener('exit', cleanup)
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
    process.once('exit', cleanup)
    return {
      rootDir,
      projects,
      cleanup,
    }
  } catch (error) {
    fs.rmSync(rootDir, { recursive: true, force: true })
    throw error
  }
}

export function cleanupStaleEvidenceContexts(
  options: CleanupEvidenceContextOptions = {},
): void {
  const parentDir = options.parentDir ?? os.tmpdir()
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_STALE_AGE_MS
  if (!fs.existsSync(parentDir)) return
  for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(CONTEXT_PREFIX)) continue
    const directory = path.join(parentDir, entry.name)
    try {
      const age = now - fs.statSync(directory).mtimeMs
      const ownerPid = contextOwnerPid(entry.name)
      if (
        (ownerPid !== undefined && !isProcessAlive(ownerPid))
        || age > maxAgeMs
      ) {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    } catch {
      // A concurrent cleanup may already have removed the directory.
    }
  }
}

function contextOwnerPid(name: string): number | undefined {
  const value = name.match(/^memory-manager-evidence-(\d+)-/)?.[1]
  if (!value) return undefined
  const pid = Number(value)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function writeProjectContext(
  rootDir: string,
  bundle: EvidenceBundle,
  index: number,
  maxBatchBytes: number,
): EvidenceProjectContext {
  const directory = path.join(rootDir, `project-${String(index + 1).padStart(4, '0')}`)
  const batchesDirectory = path.join(directory, 'batches')
  fs.mkdirSync(batchesDirectory, { recursive: true, mode: 0o700 })

  const batches = partitionExcerpts(bundle.excerpts, maxBatchBytes)
  const batchRows = batches.map((content, batchIndex) => {
    const filename = `batch-${String(batchIndex + 1).padStart(4, '0')}.md`
    const relativePath = path.join('batches', filename)
    fs.writeFileSync(path.join(directory, relativePath), content, {
      encoding: 'utf8',
      mode: 0o600,
    })
    return {
      path: relativePath,
      bytes: Buffer.byteLength(content, 'utf8'),
    }
  })
  const totalBatchBytes = batchRows.reduce((sum, batch) => sum + batch.bytes, 0)
  const readingStrategy: EvidenceReadingStrategy = totalBatchBytes <= COMPLETE_READ_MAX_BYTES
    ? 'complete'
    : 'selective'
  const baselinePath = path.join(directory, 'baseline.md')
  const existingRules = bundle.existingRules ?? []
  const baselineContent = renderBaseline(existingRules)
  fs.writeFileSync(baselinePath, baselineContent, {
    encoding: 'utf8',
    mode: 0o600,
  })
  const manifestPath = path.join(directory, 'manifest.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    version: 1,
    projectSlug: bundle.projectSlug,
    sessionCount: bundle.sourceSessions.length,
    roundCount: bundle.roundCount,
    excerptCount: bundle.excerpts.length,
    readingStrategy,
    totalBatchBytes,
    baseline: {
      path: path.basename(baselinePath),
      bytes: Buffer.byteLength(baselineContent, 'utf8'),
      ruleSourceCount: existingRules.length,
    },
    batches: batchRows,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

  return {
    projectSlug: bundle.projectSlug,
    directory,
    manifestPath,
    baselinePath,
    outputSchemaPath: path.join(directory, 'candidate-rules.schema.json'),
    batchCount: batchRows.length,
    readingStrategy,
    totalBatchBytes,
  }
}

function renderBaseline(existingRules: string[]): string {
  if (existingRules.length === 0) return '# Existing rule baseline\n\nNo existing rules discovered.\n'
  return [
    '# Existing rule baseline',
    '',
    'The following content is an existing rule source. It is not Evidence.',
    'Do not emit semantically equivalent candidates. A real user correction that conflicts with it may still be proposed.',
    '',
    ...existingRules.flatMap((rule, index) => [
      `## Rule source ${index + 1}`,
      '',
      rule,
      '',
    ]),
  ].join('\n')
}

function partitionExcerpts(
  excerpts: EvidenceExcerpt[],
  maxBatchBytes: number,
): string[] {
  if (excerpts.length === 0) return ['# Evidence\n\nNo excerpts.\n']
  const batches: string[] = []
  let current = '# Evidence\n'
  for (const excerpt of excerpts) {
    const block = renderExcerpt(excerpt)
    if (
      current !== '# Evidence\n'
      && Buffer.byteLength(current + block, 'utf8') > maxBatchBytes
    ) {
      batches.push(current)
      current = '# Evidence\n'
    }
    current += block
  }
  batches.push(current)
  return batches
}

function renderExcerpt(excerpt: EvidenceExcerpt): string {
  return [
    '',
    '<evidence>',
    `locator: ${JSON.stringify(excerpt.locator)}`,
    `role: ${excerpt.role}`,
    `evidence_kind: ${excerpt.evidenceKind ?? (excerpt.role === 'user' ? 'user_signal' : 'assistant_context')}`,
    `frequency: ${excerpt.frequency}`,
    `tools: ${JSON.stringify(excerpt.tools)}`,
    'text:',
    excerpt.text,
    '</evidence>',
    '',
  ].join('\n')
}
