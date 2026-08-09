import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../../src/db'
import {
  runLiveSessionEvidence,
  type EvidenceModelRunner,
  type SessionEvidencePlan,
} from '../../src/live-evidence-engine'
import { resolveWorkspace } from '../../src/workspace'

function createSessionFixture(count: number, messagesPerSession: number): {
  home: string
  tempParent: string
  selected: Array<{ agent: 'codex'; id: string }>
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-live-engine-many-'))
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-live-engine-many-context-'))
  const workspace = resolveWorkspace(home)
  fs.mkdirSync(workspace.workspaceDir, { recursive: true })
  const db = initDatabase(home)
  const insert = db.prepare(`
    INSERT INTO sessions (
      id, agent, source_path, workspace_link, slug, content_hash, updated_at,
      status, first_seen_at, last_seen_at
    ) VALUES (?, 'codex', ?, '/tmp/link', 'demo', 'hash', '2026-08-09',
      'updated', '2026-08-09', '2026-08-09')
  `)
  const selected = Array.from({ length: count }, (_, index) => {
    const id = `session-${index + 1}`
    const sourcePath = path.join(home, `${id}.jsonl`)
    const lines = Array.from({ length: messagesPerSession }, (_, messageIndex) => JSON.stringify({
      role: 'user',
      content: `${id} message ${messageIndex} ${'x'.repeat(180)}`,
      timestamp: `2026-08-09T00:${String(messageIndex).padStart(2, '0')}:00Z`,
    }))
    fs.writeFileSync(sourcePath, `${lines.join('\n')}\n`)
    insert.run(id, sourcePath)
    return { agent: 'codex' as const, id }
  })
  db.close()
  return { home, tempParent, selected }
}

describe('Live Session Evidence Engine', () => {
  it('Reader 开始前已取消时不读取、不调用模型且不创建 Context', async () => {
    const fixture = createSessionFixture(1, 1)
    const abortController = new AbortController()
    abortController.abort()
    const runner: EvidenceModelRunner = {
      runMap: async () => { throw new Error('不应调用 Map') },
      runReduceBatch: async () => { throw new Error('不应调用 Reduce Batch') },
      runReduce: async () => { throw new Error('不应调用 Reduce') },
    }

    try {
      await expect(runLiveSessionEvidence({
        question: '总结全部 Session',
        currentChat: { chatId: 'chat-reader-cancel' },
      }, {
        runId: 'run-reader-cancel',
        mode: 'complete',
        selected: fixture.selected,
        reason: '取消 Reader',
        batchByteBudget: 64 * 1024,
        maxConcurrency: 1,
      }, runner, {
        homeDir: fixture.home,
        tempParentDir: fixture.tempParent,
        signal: abortController.signal,
      })).rejects.toMatchObject({ code: 'RUN_CANCELLED' })
      expect(fs.readdirSync(fixture.tempParent)).toEqual([])
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true })
      fs.rmSync(fixture.tempParent, { recursive: true, force: true })
    }
  })

  it('单 Session 单 chunk 走通 Map、当前 Chat Reduce、Coverage 与 Claim Gate', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-live-engine-'))
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-live-engine-context-'))
    const workspace = resolveWorkspace(home)
    fs.mkdirSync(workspace.workspaceDir, { recursive: true })
    const sourcePath = path.join(home, 'session.jsonl')
    fs.writeFileSync(sourcePath, `${JSON.stringify({
      role: 'user',
      content: '必须先运行定向测试',
      timestamp: '2026-08-09T00:00:00Z',
    })}\n`)
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at,
        status, first_seen_at, last_seen_at
      ) VALUES ('session-1', 'codex', ?, '/tmp/link', 'demo', 'hash', '2026-08-09',
        'updated', '2026-08-09', '2026-08-09')
    `).run(sourcePath)
    db.close()
    const plan: SessionEvidencePlan = {
      runId: 'run-1',
      mode: 'complete',
      selected: [{ agent: 'codex', id: 'session-1' }],
      reason: '用户要求总结全部选中 Session',
      batchByteBudget: 64 * 1024,
      maxConcurrency: 1,
    }
    const calls: string[] = []
    const runner: EvidenceModelRunner = {
      runMap: async (input) => {
        calls.push(`map:${input.sessionId}:${input.chunkIndex}`)
        const chunk = fs.readFileSync(input.chunkPath, 'utf8')
        expect(chunk).toContain('必须先运行定向测试')
        expect(chunk).toContain('"messageIndex":0')
        return {
          sessionId: input.sessionId,
          agent: input.agent,
          chunkIndex: input.chunkIndex,
          chunkCount: input.chunkCount,
          summary: '用户要求先跑定向测试',
          facts: [{
            id: 'fact-1',
            text: '先运行定向测试',
            kind: 'explicit',
            locators: [{
              sessionId: input.sessionId,
              agent: input.agent,
              messageIndex: 0,
              timestamp: '2026-08-09T00:00:00Z',
              sourceRevision: input.sourceRevision,
            }],
          }],
          relevant: true,
        }
      },
      runReduceBatch: async () => {
        throw new Error('单 Capsule 不应触发中间 Reduce')
      },
      runReduce: async (input) => {
        calls.push(`reduce:${input.currentChat.chatId}:${input.currentChat.nativeSessionId}`)
        expect(input.coverage.status).toBe('complete')
        expect(input.evidence).toHaveLength(1)
        return {
          answerMarkdown: '总结：先运行定向测试。',
          claims: [{ text: '先运行定向测试', evidenceFactIds: ['fact-1'] }],
          limitations: [],
        }
      },
    }

    try {
      const result = await runLiveSessionEvidence({
        question: '总结这些 Session 的经验',
        currentChat: {
          chatId: 'chat-current',
          nativeSessionId: 'native-current',
        },
      }, plan, runner, { homeDir: home, tempParentDir: tempParent })

      expect(calls).toEqual([
        'map:session-1:0',
        'reduce:chat-current:native-current',
      ])
      expect(result.coverage).toMatchObject({
        status: 'complete', selected: 1, visited: 1, readable: 1, processed: 1, relevant: 1,
      })
      expect(result.claimGate).toMatchObject({ allowed: true, violations: [] })
      expect(result.renderedAnswer).toBe('总结：先运行定向测试。')
      expect(fs.readdirSync(tempParent)).toEqual([])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(tempParent, { recursive: true, force: true })
    }
  })

  it('10 个 Session 多 chunk 使用有界并发、分层 Reduce，并逐 Session 记录失败', async () => {
    const fixture = createSessionFixture(10, 4)
    let activeMaps = 0
    let maxActiveMaps = 0
    let reduceBatchCalls = 0
    const runner: EvidenceModelRunner = {
      runMap: async (input) => {
        activeMaps += 1
        maxActiveMaps = Math.max(maxActiveMaps, activeMaps)
        await new Promise((resolve) => setTimeout(resolve, 2))
        activeMaps -= 1
        if (input.sessionId === 'session-4' && input.chunkIndex === 1) {
          throw new Error('injected map failure')
        }
        const chunk = fs.readFileSync(input.chunkPath, 'utf8')
        const messageIndex = Number(chunk.match(/"messageIndex":(\d+)/)?.[1])
        return {
          sessionId: input.sessionId,
          agent: input.agent,
          chunkIndex: input.chunkIndex,
          chunkCount: input.chunkCount,
          summary: `${input.sessionId}/${input.chunkIndex}`,
          facts: [{
            id: `fact-${input.sessionId}-${input.chunkIndex}`,
            text: 'fact',
            kind: 'explicit',
            locators: [{
              sessionId: input.sessionId,
              agent: input.agent,
              messageIndex,
              sourceRevision: input.sourceRevision,
            }],
          }],
          relevant: true,
        }
      },
      runReduceBatch: async (input) => {
        reduceBatchCalls += 1
        return {
          summary: `level-${input.level}-batch-${input.batchIndex}`,
          evidenceFactIds: input.evidence.flatMap((material) => material.kind === 'capsule'
            ? material.capsule.facts.map((fact) => fact.id)
            : material.batch.evidenceFactIds),
        }
      },
      runReduce: async (input) => {
        expect(input.evidence.every((material) => material.kind === 'batch')).toBe(true)
        return {
          answerMarkdown: '部分证据总结。',
          claims: [],
          limitations: ['session-4 的一个 chunk 处理失败'],
        }
      },
    }

    try {
      const result = await runLiveSessionEvidence({
        question: '总结这些 Session',
        currentChat: { chatId: 'chat-many' },
      }, {
        runId: 'run-many',
        mode: 'complete',
        selected: fixture.selected,
        reason: '多 Session 完整总结',
        batchByteBudget: 1_100,
        maxConcurrency: 3,
      }, runner, { homeDir: fixture.home, tempParentDir: fixture.tempParent })

      expect(maxActiveMaps).toBe(3)
      expect(reduceBatchCalls).toBeGreaterThan(0)
      expect(result.capsules.every((capsule) => capsule.sessionId !== 'session-4')).toBe(true)
      expect(result.coverage).toMatchObject({
        status: 'partial', selected: 10, readable: 10, processed: 9, processFailed: 1,
      })
      expect(result.coverage.rows.find((row) => row.sessionId === 'session-4')).toMatchObject({
        processingStatus: 'failed', errorCode: 'MAP_FAILED',
      })
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true })
      fs.rmSync(fixture.tempParent, { recursive: true, force: true })
    }
  })

  it('151 个 readable Session 全部进入唯一 processing 终态', async () => {
    const fixture = createSessionFixture(151, 1)
    let activeMaps = 0
    let maxActiveMaps = 0
    const runner: EvidenceModelRunner = {
      runMap: async (input) => {
        activeMaps += 1
        maxActiveMaps = Math.max(maxActiveMaps, activeMaps)
        await new Promise((resolve) => setTimeout(resolve, 1))
        activeMaps -= 1
        return {
          sessionId: input.sessionId,
          agent: input.agent,
          chunkIndex: input.chunkIndex,
          chunkCount: input.chunkCount,
          summary: input.sessionId,
          facts: [],
          relevant: false,
        }
      },
      runReduceBatch: async () => {
        throw new Error('大预算不应触发中间 Reduce')
      },
      runReduce: async () => ({
        answerMarkdown: '151 个 Session 已完成处理。',
        claims: [],
        limitations: [],
      }),
    }

    try {
      const result = await runLiveSessionEvidence({
        question: '总结全部 Session',
        currentChat: { chatId: 'chat-151' },
      }, {
        runId: 'run-151',
        mode: 'complete',
        selected: fixture.selected,
        reason: '规模边界检查',
        batchByteBudget: 10 * 1024 * 1024,
        maxConcurrency: 5,
      }, runner, { homeDir: fixture.home, tempParentDir: fixture.tempParent })

      expect(maxActiveMaps).toBe(5)
      expect(result.coverage).toMatchObject({
        status: 'complete', selected: 151, visited: 151, readable: 151,
        processed: 151, processFailed: 0,
      })
      expect(result.coverage.rows.every((row) => row.processingStatus === 'processed')).toBe(true)
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true })
      fs.rmSync(fixture.tempParent, { recursive: true, force: true })
    }
  })
})
