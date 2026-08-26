import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupStaleEvidenceContexts,
  createEvidenceContext,
} from '../../src/evidence-context'
import type { EvidenceBundle } from '../../src/evidence'

const bundle: EvidenceBundle = {
  projectSlug: '../unsafe/project',
  sourceSessions: ['s1'],
  roundCount: 2,
  existingRules: ['always respond in 中文。', '所有 shell 命令前加 rtk 前缀。'],
  excerpts: [{
    locator: { sessionId: 's1', agent: 'claude', messageIndex: 0 },
    role: 'user',
    evidenceKind: 'user_signal',
    text: '第一条完整 Evidence\n包含换行',
    tools: [],
    frequency: 1,
  }, {
    locator: { sessionId: 's1', agent: 'claude', messageIndex: 1 },
    role: 'assistant',
    evidenceKind: 'assistant_context',
    text: '第二条完整 Evidence',
    tools: [{ tool: 'Read', summary: '调用工具' }],
    frequency: 1,
  }],
}

describe('EvidenceContext', () => {
  it('写入受限临时目录、manifest 与完整分批正文，并安全清理', () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-context-parent-'))
    try {
      const context = createEvidenceContext([bundle], {
        parentDir,
        maxBatchBytes: 160,
      })
      expect(fs.statSync(context.rootDir).mode & 0o777).toBe(0o700)
      expect(context.projects).toHaveLength(1)
      const project = context.projects[0]
      expect(project.directory.startsWith(context.rootDir)).toBe(true)
      expect(project.directory).not.toContain('unsafe')
      expect(project.batchCount).toBeGreaterThan(1)

      const manifest = JSON.parse(fs.readFileSync(project.manifestPath, 'utf8')) as {
        projectSlug: string
        excerptCount: number
        readingStrategy: string
        totalBatchBytes: number
        batches: Array<{ path: string }>
        baseline: { path: string }
      }
      expect(manifest.projectSlug).toBe('../unsafe/project')
      expect(manifest.excerptCount).toBe(2)
      expect(project.readingStrategy).toBe('complete')
      expect(manifest.readingStrategy).toBe('complete')
      expect(manifest.totalBatchBytes).toBeGreaterThan(0)
      const content = manifest.batches
        .map((batch) => fs.readFileSync(path.join(project.directory, batch.path), 'utf8'))
        .join('\n')
      expect(content).toContain('第一条完整 Evidence\n包含换行')
      expect(content).toContain('第二条完整 Evidence')
      expect(content).toContain('"messageIndex":0')
      expect(content).toContain('evidence_kind: user_signal')
      expect(content).toContain('evidence_kind: assistant_context')
      const baseline = fs.readFileSync(
        path.join(project.directory, manifest.baseline.path),
        'utf8',
      )
      expect(baseline).toContain('always respond in 中文')
      expect(baseline).toContain('所有 shell 命令前加 rtk 前缀')
      expect(content).not.toContain('always respond in 中文')

      context.cleanup()
      expect(fs.existsSync(context.rootDir)).toBe(false)
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  it('Evidence 正文超过阈值时标记为选择性读取', () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-context-large-'))
    try {
      const context = createEvidenceContext([{
        ...bundle,
        excerpts: [{
          ...bundle.excerpts[0],
          text: '必须保留的大型 Evidence\n'.repeat(8_000),
        }],
      }], { parentDir, maxBatchBytes: 32 * 1024 })
      const project = context.projects[0]
      const manifest = JSON.parse(fs.readFileSync(project.manifestPath, 'utf8')) as {
        readingStrategy: string
        totalBatchBytes: number
      }

      expect(project.readingStrategy).toBe('selective')
      expect(manifest.readingStrategy).toBe('selective')
      expect(manifest.totalBatchBytes).toBeGreaterThan(128 * 1024)
      context.cleanup()
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  it('只清理超过期限的遗留 Evidence Context', () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-context-stale-'))
    try {
      const stale = fs.mkdtempSync(path.join(parentDir, 'memory-manager-evidence-'))
      const fresh = fs.mkdtempSync(path.join(parentDir, 'memory-manager-evidence-'))
      fs.utimesSync(stale, new Date(0), new Date(0))

      cleanupStaleEvidenceContexts({
        parentDir,
        now: Date.parse('2026-07-30T00:00:00.000Z'),
        maxAgeMs: 60_000,
      })

      expect(fs.existsSync(stale)).toBe(false)
      expect(fs.existsSync(fresh)).toBe(true)
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })
})
