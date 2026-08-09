import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createCoverageState,
  finalizeCoverage,
  recordProcessingOutcome,
  recordSourceOutcome,
} from '../../src/evidence-coverage'
import {
  cleanupStaleLiveEvidenceContexts,
  createLiveEvidenceContext,
  withLiveEvidenceContext,
} from '../../src/live-evidence-context'
import type { SessionSourceReadResult } from '../../src/session-source-reader'

describe('LiveEvidenceContext', () => {
  it('以私有权限写入 manifest、分片、coverage 与 capsule，并保留 locator', () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-live-context-parent-'))
    const selected = [{ agent: 'claude', id: 'session-1' }] as const
    try {
      const context = createLiveEvidenceContext({
        runId: '../unsafe/run',
        mode: 'complete',
        selected: [...selected],
      }, { parentDir, maxChunkBytes: 190 })
      expect(path.dirname(context.rootDir)).toBe(parentDir)
      expect(path.basename(context.rootDir)).not.toContain('unsafe')
      expect(fs.statSync(context.rootDir).mode & 0o777).toBe(0o700)
      expect(fs.statSync(context.sourcesDir).mode & 0o777).toBe(0o700)
      expect(fs.statSync(context.capsulesDir).mode & 0o777).toBe(0o700)

      const readResult: SessionSourceReadResult = {
        sessionId: 'session-1',
        agent: 'claude',
        projectSlug: 'demo',
        status: 'readable',
        messageCount: 3,
        messages: [
          { role: 'user', content: 'first message' },
          { role: 'assistant', content: 'second message' },
          { role: 'user', content: 'third message' },
        ],
        sourceRevision: {
          kind: 'jsonl-watermark',
          fingerprint: 'a'.repeat(64),
          changedDuringRun: false,
        },
      }
      const source = context.writeSessionChunks(readResult)
      expect(source.chunkCount).toBeGreaterThan(1)
      expect(source.chunkPaths.every((chunkPath) => (
        fs.statSync(chunkPath).mode & 0o777
      ) === 0o600)).toBe(true)
      const content = source.chunkPaths.map((chunkPath) => fs.readFileSync(chunkPath, 'utf8')).join('\n')
      expect(content).toContain('"messageIndex":0')
      expect(content).toContain('"messageIndex":1')
      expect(content).toContain('"messageIndex":2')
      expect(content).toContain(`"sourceRevision":"${'a'.repeat(64)}"`)
      expect(content.indexOf('first message')).toBeLessThan(content.indexOf('third message'))

      let coverage = createCoverageState('../unsafe/run', 'complete', [...selected])
      coverage = recordSourceOutcome(coverage, {
        ...selected[0],
        status: 'readable',
        messageCount: 3,
        sourceRevision: readResult.sourceRevision,
      })
      coverage = recordProcessingOutcome(coverage, {
        ...selected[0],
        status: 'processed',
        relevant: true,
      })
      context.writeCoverage(finalizeCoverage(coverage))
      const capsulePath = context.writeCapsule({
        sessionId: 'session-1',
        agent: 'claude',
        chunkIndex: 0,
        chunkCount: source.chunkCount,
        summary: 'summary',
        facts: [],
        relevant: true,
      })

      const manifest = JSON.parse(fs.readFileSync(context.manifestPath, 'utf8')) as {
        runId: string
        sessions: Array<{ id: string; directory: string; chunks: Array<{ path: string }> }>
      }
      expect(manifest.runId).toBe('../unsafe/run')
      expect(manifest.sessions).toEqual([expect.objectContaining({
        id: 'session-1',
        directory: 'sources/session-0001',
        chunks: expect.any(Array),
      })])
      expect(fs.statSync(context.manifestPath).mode & 0o777).toBe(0o600)
      expect(fs.statSync(context.coveragePath).mode & 0o777).toBe(0o600)
      expect(fs.statSync(capsulePath).mode & 0o777).toBe(0o600)

      context.cleanup()
      expect(fs.existsSync(context.rootDir)).toBe(false)
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  it.each([
    ['success', false, false],
    ['failure', true, false],
    ['cancel', true, true],
  ] as const)('%s 终态都由 wrapper 清理临时正文', async (name, shouldThrow, aborted) => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-live-lifecycle-'))
    const controller = new AbortController()
    let rootDir = ''
    try {
      const operation = withLiveEvidenceContext({
        runId: `run-${name}`,
        mode: 'complete',
        selected: [{ agent: 'codex', id: 'session-1' }],
      }, { parentDir }, async (context) => {
        rootDir = context.rootDir
        expect(fs.existsSync(rootDir)).toBe(true)
        if (aborted) controller.abort()
        if (shouldThrow) {
          throw aborted
            ? Object.assign(new Error('aborted'), { name: 'AbortError' })
            : new Error('reader failed')
        }
        return 'done'
      }, controller.signal)

      if (shouldThrow) await expect(operation).rejects.toThrow(aborted ? 'aborted' : 'reader failed')
      else await expect(operation).resolves.toBe('done')
      expect(fs.existsSync(rootDir)).toBe(false)
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  it('启动清理删除超 TTL 或 owner PID 消失的目录，并保留活跃与无关目录', () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-live-stale-'))
    try {
      const staleByAge = fs.mkdtempSync(path.join(
        parentDir,
        `memory-manager-live-evidence-${process.pid}-old-`,
      ))
      const staleByOwner = fs.mkdtempSync(path.join(
        parentDir,
        'memory-manager-live-evidence-2147483647-dead-',
      ))
      const active = fs.mkdtempSync(path.join(
        parentDir,
        `memory-manager-live-evidence-${process.pid}-active-`,
      ))
      const unrelated = fs.mkdtempSync(path.join(parentDir, 'unrelated-'))
      fs.utimesSync(staleByAge, new Date(0), new Date(0))

      cleanupStaleLiveEvidenceContexts({
        parentDir,
        now: Date.parse('2026-08-09T00:00:00Z'),
        maxAgeMs: 60_000,
      })

      expect(fs.existsSync(staleByAge)).toBe(false)
      expect(fs.existsSync(staleByOwner)).toBe(false)
      expect(fs.existsSync(active)).toBe(true)
      expect(fs.existsSync(unrelated)).toBe(true)
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })
})
