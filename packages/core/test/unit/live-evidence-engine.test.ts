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

describe('Live Session Evidence Engine', () => {
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
      runReduce: async (input) => {
        calls.push(`reduce:${input.currentChat.chatId}:${input.currentChat.nativeSessionId}`)
        expect(input.coverage.status).toBe('complete')
        expect(input.capsules).toHaveLength(1)
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
})
