import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from '@jest/globals'
import { ChatStore } from '../main/chat-store.js'
import type { GenerationStatus } from '../main/generation-controller.js'

const temporaryRoots: string[] = []

function createStore(): { chatsDir: string; store: ChatStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-manager-chat-'))
  temporaryRoots.push(root)
  const chatsDir = path.join(root, 'chats')
  return { chatsDir, store: new ChatStore(chatsDir) }
}

function runningStatus(runId: string): GenerationStatus {
  return {
    running: true,
    state: 'running',
    runId,
    lastSeq: 2,
    request: { mode: 'projects', projects: ['rules-manager'] },
    progress: { phase: 'generating', projectSlug: 'rules-manager' },
    evidence: {
      mode: 'projects',
      projects: [{
        slug: 'rules-manager',
        sessionIds: ['session-1'],
        roundCount: 3,
        excerptCount: 6,
      }],
      totalSessions: 1,
      createdAt: '2026-07-30T00:00:01.000Z',
    },
    projectResponses: [{
      projectSlug: 'rules-manager',
      summary: '发现一条可复用规则。',
      candidates: [{
        rule: '每次实现后运行完整测试。',
        scope: 'project',
        confidence: 'high',
        reasoning: '多个 Session 重复出现。',
        evidenceRefs: ['session-1:0'],
      }],
    }],
    events: [
      {
        runId,
        seq: 1,
        at: '2026-07-30T00:00:01.500Z',
        event: {
          kind: 'activity',
          activity: {
            id: 'read-1',
            kind: 'read',
            label: 'Read',
            status: 'running',
          },
        },
      },
      {
        runId,
        seq: 2,
        at: '2026-07-30T00:00:01.800Z',
        event: {
          kind: 'activity',
          activity: {
            id: 'read-1',
            kind: 'read',
            label: 'Read',
            status: 'completed',
            detail: 'packages/app/renderer/src/views/ChatView.tsx',
          },
        },
      },
      {
        runId,
        seq: 3,
        at: '2026-07-30T00:00:01.900Z',
        event: {
          kind: 'phase',
          progress: {
            phase: 'generating',
            current: 1,
            total: 2,
            projectSlug: 'rules-manager',
          },
        },
      },
    ],
    output: 'raw provider output must not be persisted',
    outputTruncated: false,
    startedAt: '2026-07-30T00:00:00.000Z',
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('ChatStore', () => {
  it('兼容 v1，并持久化 v2 Native Chat 的可见投影与原生引用', () => {
    const { chatsDir, store } = createStore()
    store.createNativeThread({
      id: 'chat-native',
      provider: 'claude',
      origin: 'chat',
      title: '解释这个项目',
      createdAt: '2026-08-01T01:00:00.000Z',
      defaultTurnConfig: { model: 'claude-sonnet', effort: 'high', fastMode: false },
    })
    store.appendNativeMessage('chat-native', {
      id: 'message-user-1', role: 'user', kind: 'text', content: '解释这个项目',
      status: 'completed', createdAt: '2026-08-01T01:00:00.000Z',
      turnConfig: { model: 'claude-sonnet', effort: 'high', fastMode: false },
    })
    store.bindNativeSession('chat-native', 'native-claude-1', '2026-08-01T01:00:01.000Z')
    store.appendNativeMessage('chat-native', {
      id: 'message-assistant-1', role: 'assistant', kind: 'text', content: '这是一个本地 Session 管理器。',
      status: 'completed', createdAt: '2026-08-01T01:00:01.000Z',
    })

    expect(store.readThread('chat-native')).toMatchObject({
      version: 2,
      id: 'chat-native',
      provider: 'claude',
      nativeSessionId: 'native-claude-1',
      nativeState: 'ready',
      messages: [
        { role: 'user', content: '解释这个项目', turnConfig: { effort: 'high' } },
        { role: 'assistant', content: '这是一个本地 Session 管理器。' },
      ],
    })
    const persisted = fs.readFileSync(path.join(chatsDir, 'chat-native', 'thread.json'), 'utf8')
      + fs.readFileSync(path.join(chatsDir, 'chat-native', 'messages.jsonl'), 'utf8')
    expect(persisted).not.toContain('host_session_context')
    expect(persisted).not.toContain('systemPrompt')
    expect(store.listThreads().map((thread) => thread.id)).toContain('chat-native')
  })

  it('Session Context 只在集合变化时递增 revision，并独立记录最后成功注入集合', () => {
    const { store } = createStore()
    store.createNativeThread({
      id: 'chat-context', provider: 'codex', origin: 'chat', title: 'context',
      createdAt: '2026-08-01T01:00:00.000Z',
      defaultTurnConfig: { effort: 'high', fastMode: false },
    })
    expect(store.setNativeSessionContext('chat-context', [
      { agent: 'codex', id: 's-2' }, { agent: 'claude', id: 's-1' },
    ], '2026-08-01T01:00:01.000Z')).toMatchObject({ revision: 1 })
    expect(store.setNativeSessionContext('chat-context', [
      { agent: 'claude', id: 's-1' }, { agent: 'codex', id: 's-2' },
    ], '2026-08-01T01:00:02.000Z')).toMatchObject({ revision: 1 })

    store.markNativeSessionContextInjected('chat-context', 1, [
      { agent: 'claude', id: 's-1' }, { agent: 'codex', id: 's-2' },
    ], '2026-08-01T01:00:03.000Z')
    expect(store.readThread('chat-context')).toMatchObject({
      sessionContext: {
        revision: 1,
        lastInjectedRevision: 1,
        selected: [{ agent: 'claude', id: 's-1' }, { agent: 'codex', id: 's-2' }],
        lastInjectedSelected: [{ agent: 'claude', id: 's-1' }, { agent: 'codex', id: 's-2' }],
      },
    })
  })

  it('Native Chat 支持重命名、Archive/Restore，并只允许删除 Archived', () => {
    const { chatsDir, store } = createStore()
    store.createNativeThread({
      id: 'chat-lifecycle', provider: 'claude', origin: 'chat', title: 'before',
      createdAt: '2026-08-01T01:00:00.000Z',
      defaultTurnConfig: { effort: 'high', fastMode: false },
    })
    store.bindNativeSession('chat-lifecycle', 'native-lifecycle', '2026-08-01T01:00:01.000Z')
    store.renameNativeThread('chat-lifecycle', 'after', '2026-08-01T01:00:02.000Z')
    expect(store.readThread('chat-lifecycle')).toMatchObject({
      title: 'after', titleSource: 'manual', archivedAt: null,
    })
    expect(() => store.deleteArchivedNativeThread('chat-lifecycle')).toThrow('must be archived')
    store.archiveNativeThread('chat-lifecycle', '2026-08-01T01:00:03.000Z')
    expect(store.readThread('chat-lifecycle')).toMatchObject({
      archivedAt: '2026-08-01T01:00:03.000Z',
    })
    store.unarchiveNativeThread('chat-lifecycle', '2026-08-01T01:00:04.000Z')
    expect(store.readThread('chat-lifecycle')).toMatchObject({ archivedAt: null })
    store.archiveNativeThread('chat-lifecycle', '2026-08-01T01:00:05.000Z')
    store.deleteArchivedNativeThread('chat-lifecycle')
    expect(store.readThread('chat-lifecycle')).toBeNull()
    expect(fs.existsSync(path.join(chatsDir, 'chat-lifecycle'))).toBe(false)
  })

  it('创建 FS-first Generation Thread 并保存用户可见请求', () => {
    const { chatsDir, store } = createStore()
    store.createGenerationThread({
      runId: 'run-1',
      request: {
        mode: 'projects',
        projects: ['rules-manager'],
        provider: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
        fastMode: true,
      },
      startedAt: '2026-07-30T00:00:00.000Z',
    })

    expect(fs.existsSync(path.join(chatsDir, 'run-1', 'thread.json'))).toBe(true)
    expect(fs.existsSync(path.join(chatsDir, 'run-1', 'messages.jsonl'))).toBe(true)
    expect(store.readThread('run-1')).toMatchObject({
      id: 'run-1',
      kind: 'rules-generation',
      status: 'running',
      request: {
        mode: 'projects',
        projects: ['rules-manager'],
        provider: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
        fastMode: true,
      },
      messages: [{ role: 'user', kind: 'rules-generation-request' }],
    })
  })

  it('checkpoint 可见 Assistant 摘要与 Artifact，终态转为完整消息且不保存 raw output', () => {
    const { chatsDir, store } = createStore()
    store.createGenerationThread({
      runId: 'run-2',
      request: { mode: 'projects', projects: ['rules-manager'] },
      startedAt: '2026-07-30T00:00:00.000Z',
    })
    store.syncGeneration(runningStatus('run-2'))

    expect(fs.existsSync(
      path.join(chatsDir, 'run-2', 'assistant.partial.json'),
    )).toBe(true)
    expect(store.readThread('run-2')).toMatchObject({
      status: 'running',
      evidence: { totalSessions: 1 },
      projectResponses: [{ projectSlug: 'rules-manager' }],
      activities: [{
        id: 'read-1',
        kind: 'read',
        label: 'Read',
        status: 'completed',
        detail: 'packages/app/renderer/src/views/ChatView.tsx',
      }, {
        kind: 'analyze',
        label: 'Analyze',
        detail: 'rules-manager · 1/2',
      }],
      messages: [{
        role: 'user',
      }, {
        role: 'assistant',
        status: 'streaming',
        content: '发现一条可复用规则。',
      }],
    })

    store.syncGeneration({
      ...runningStatus('run-2'),
      running: false,
      state: 'completed',
      endedAt: '2026-07-30T00:00:02.000Z',
    })

    expect(fs.existsSync(
      path.join(chatsDir, 'run-2', 'assistant.partial.json'),
    )).toBe(false)
    const restored = store.readThread('run-2')
    expect(restored?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'completed',
      content: '发现一条可复用规则。',
    })
    expect(JSON.stringify(restored)).not.toContain('raw provider output')
  })

  it('部分项目失败时以 completed 保存成功候选并记录失败项目', () => {
    const { store } = createStore()
    store.createGenerationThread({
      runId: 'run-partial',
      request: { mode: 'projects', projects: ['rules-manager', 'broken'] },
      startedAt: '2026-07-30T00:00:00.000Z',
    })
    const successful = runningStatus('run-partial').projectResponses[0]
    const failed = {
      projectSlug: 'broken',
      summary: 'Failed to generate rule candidates for broken: invalid output',
      candidates: [],
      status: 'failed' as const,
      error: 'invalid output',
    }

    store.syncGeneration({
      ...runningStatus('run-partial'),
      running: false,
      state: 'completed',
      progress: {
        phase: 'done',
        candidateCount: 1,
        failedProjectCount: 1,
      },
      projectResponses: [
        { ...successful, status: 'completed' },
        failed,
      ],
      events: [{
        runId: 'run-partial',
        seq: 1,
        at: '2026-07-30T00:00:01.000Z',
        event: { kind: 'project_response', response: failed },
      }],
      endedAt: '2026-07-30T00:00:02.000Z',
    })

    expect(store.readThread('run-partial')).toMatchObject({
      status: 'completed',
      candidateCount: 1,
      projectResponses: [
        {
          projectSlug: 'rules-manager',
          status: 'completed',
          candidates: [{ rule: '每次实现后运行完整测试。' }],
        },
        {
          projectSlug: 'broken',
          status: 'failed',
          error: 'invalid output',
          candidates: [],
        },
      ],
      activities: [{
        kind: 'retry',
        label: 'Failed',
        detail: 'broken: invalid output',
      }],
      messages: [{
        role: 'user',
      }, {
        role: 'assistant',
        status: 'completed',
        content: expect.stringContaining('Failed to generate rule candidates for broken'),
      }],
    })
  })

  it('启动恢复时把遗留运行 Thread 标为 interrupted 并保留已写正文', () => {
    const { store } = createStore()
    store.createGenerationThread({
      runId: 'run-3',
      request: { mode: 'recent', projects: [] },
      startedAt: '2026-07-30T00:00:00.000Z',
    })
    store.syncGeneration({
      ...runningStatus('run-3'),
      request: { mode: 'recent', projects: [] },
    })

    store.markInterruptedThreads('2026-07-30T00:01:00.000Z')

    expect(store.readThread('run-3')).toMatchObject({
      status: 'interrupted',
      messages: [
        { role: 'user' },
        { role: 'assistant', status: 'interrupted', content: '发现一条可复用规则。' },
      ],
    })
  })

  it('按更新时间倒序列举，并隔离损坏或非法目录', () => {
    const { chatsDir, store } = createStore()
    store.createGenerationThread({
      runId: 'older',
      request: { mode: 'recent', projects: [] },
      startedAt: '2026-07-29T00:00:00.000Z',
    })
    store.createGenerationThread({
      runId: 'newer',
      request: { mode: 'full', projects: [] },
      startedAt: '2026-07-30T00:00:00.000Z',
    })
    fs.mkdirSync(path.join(chatsDir, 'broken'), { recursive: true })
    fs.writeFileSync(path.join(chatsDir, 'broken', 'thread.json'), '{bad json')

    expect(store.listThreads().map((thread) => thread.id)).toEqual(['newer', 'older'])
    expect(() => store.readThread('../outside')).toThrow('invalid chat thread id')
  })
})
