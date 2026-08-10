import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { jest } from '@jest/globals'
import { runRulesGenerate } from '../../src/commands/rules-generate'
import { initDatabase } from '../../src/db'
import type { EvidenceBundle } from '../../src/evidence'
import { resolveWorkspace } from '../../src/workspace'

const evidence: EvidenceBundle[] = [{
  projectSlug: 'demo',
  sourceSessions: ['s1'],
  roundCount: 1,
  existingRules: [],
  excerpts: [{
    locator: { sessionId: 's1', agent: 'claude', messageIndex: 0 },
    role: 'user',
    evidenceKind: 'user_signal',
    text: 'Remember this rule: always run tests',
    tools: [],
    frequency: 1,
  }],
}]

const generated = [{
  scope: 'project' as const,
  project_slug: 'demo',
  rule_text: 'Always run tests',
  confidence_level: 'high' as const,
  reasoning: 'Explicit requirement',
  evidence_refs: ['s1:0'],
}]

function evidenceContextDirectories(): string[] {
  return fs.readdirSync(os.tmpdir())
    .filter((entry) => entry.startsWith('memory-manager-evidence-'))
    .sort()
}

describe('runRulesGenerate', () => {
  let home: string
  let output: string[]
  let originalLog: typeof console.log

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-rules-generate-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
    const db = initDatabase(home)
    db.close()
    output = []
    originalLog = console.log
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '))
  })

  afterEach(() => {
    console.log = originalLog
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('dry-run 输出候选但不写 rule_candidates 或 llm_runs', async () => {
    await runRulesGenerate({ homeDir: home, dryRun: true }, {
      extract: async () => evidence,
      generate: async () => generated,
    })

    const db = initDatabase(home)
    expect((db.prepare('SELECT COUNT(*) AS count FROM rule_candidates').get() as { count: number }).count).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS count FROM llm_runs').get() as { count: number }).count).toBe(0)
    db.close()
    expect(output.join('\n')).toContain('Always run tests')
  })

  it('正常运行只写 evidence 引用和 llm_run hash，不把原文写入 DB', async () => {
    await runRulesGenerate({ homeDir: home, provider: 'claude', model: 'test-model' }, {
      extract: async () => evidence,
      generate: async () => generated,
    })

    const db = initDatabase(home)
    const candidate = db.prepare('SELECT * FROM rule_candidates').get() as Record<string, unknown>
    const run = db.prepare('SELECT * FROM llm_runs').get() as Record<string, unknown>
    db.close()
    expect(candidate.rule_text).toBe('Always run tests')
    expect(candidate.status).toBe('draft')
    expect(JSON.parse(candidate.evidence_json as string)).toEqual({
      reasoning: 'Explicit requirement',
      evidence_refs: ['s1:0'],
    })
    expect(candidate.evidence_json).not.toContain('Always run tests')
    expect(run.model).toBe('test-model')
    expect(run.input_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(run.output_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(run)).not.toContain('Always run tests')
  })

  it('把配置中的完整 effort 与 Fast Mode 传给生成器', async () => {
    fs.writeFileSync(
      path.join(resolveWorkspace(home).workspaceDir, 'config.json'),
      JSON.stringify({ provider: 'claude', effort: 'xhigh', fastMode: true }),
    )
    const generate = jest.fn(async (..._args: unknown[]) => generated)

    await runRulesGenerate({ homeDir: home, dryRun: true }, {
      extract: async () => evidence,
      generate,
    })

    expect(generate).toHaveBeenCalledWith(
      expect.any(String),
      'claude',
      undefined,
      'xhigh',
      true,
      expect.objectContaining({
        cwd: expect.any(String),
        outputSchemaPath: expect.any(String),
      }),
    )
    const prompt = generate.mock.calls[0][0]
    expect(prompt).toContain('manifest.json')
    expect(prompt).toContain('读取 manifest 列出的全部 batch')
    expect(prompt).not.toContain('禁止依次或完整读取全部 batch')
    expect(prompt).toContain('user_signal')
    expect(prompt).toContain('assistant_context')
    expect(prompt).toContain('baseline')
    expect(prompt).toContain('保守下界')
    expect(prompt).toContain('默认只能产出 project rule')
    expect(prompt).toContain('一次性任务')
    expect(prompt).toContain('至少两个不同 Session')
    expect(prompt).toContain('至少两条独立的明确用户纠正')
    expect(prompt).toContain('明确要求“记住、写入规则或记忆、以后持续遵循”')
    expect(prompt).toContain('单次普通要求、单次禁止、单次纠正')
    expect(prompt).toContain('同一个 locator 重复写入')
    expect(prompt).toContain('每条候选只表达一个行为约束')
    expect(prompt).toContain('不要输出 low')
    expect(prompt).not.toContain('Always run tests')
    expect(generate.mock.calls[0][5]).toEqual(expect.objectContaining({
      maxTurns: 32,
      tools: ['Read', 'Grep', 'Glob'],
    }))
  })

  it('大型 Evidence 使用选择性检索并要求逐 batch 覆盖检查', async () => {
    const generate = jest.fn(async (..._args: unknown[]) => generated)
    const largeEvidence: EvidenceBundle[] = [{
      ...evidence[0],
      excerpts: [{
        ...evidence[0].excerpts[0],
        text: 'Always run tests\n'.repeat(12_000),
      }],
    }]

    await runRulesGenerate({ homeDir: home, dryRun: true }, {
      extract: async () => largeEvidence,
      generate,
    })

    const prompt = generate.mock.calls[0][0]
    expect(prompt).toContain('优先使用 Glob 和 Grep')
    expect(prompt).toContain('不要依次或完整读取全部 batch')
    expect(prompt).toContain('每个 batch 都至少参与过一次搜索')
    expect(prompt).toContain('只对命中的相关位置使用 Read')
    expect(prompt).not.toContain('读取 manifest 列出的全部 batch')
  })

  it('规范化 scope 并过滤 low 候选', async () => {
    const scopedEvidence: EvidenceBundle[] = [{
      projectSlug: 'demo',
      sourceSessions: ['s1'],
      roundCount: 2,
      existingRules: [],
      excerpts: [{
        locator: { sessionId: 's1', agent: 'claude', messageIndex: 0 },
        role: 'user',
        evidenceKind: 'user_signal',
        text: '请记住，在这个项目中，修改代码前先运行测试。',
        tools: [],
        frequency: 1,
      }, {
        locator: { sessionId: 's1', agent: 'claude', messageIndex: 1 },
        role: 'user',
        evidenceKind: 'user_signal',
        text: '请记住，所有项目中都使用中文回复。',
        tools: [],
        frequency: 1,
      }],
    }]

    await runRulesGenerate({ homeDir: home }, {
      extract: async () => scopedEvidence,
      generate: async () => [{
        scope: 'project',
        project_slug: 'other-project',
        rule_text: '修改代码前先运行测试。',
        confidence_level: 'medium',
        reasoning: '项目内明确要求',
        evidence_refs: ['s1:0'],
      }, {
        scope: 'global',
        project_slug: 'other-project',
        rule_text: '修改代码前始终运行测试。',
        confidence_level: 'high',
        reasoning: '错误提升为全局',
        evidence_refs: ['s1:0'],
      }, {
        scope: 'global',
        project_slug: 'other-project',
        rule_text: '所有项目都使用中文回复。',
        confidence_level: 'high',
        reasoning: '明确的跨项目要求',
        evidence_refs: ['s1:1'],
      }, {
        scope: 'project',
        project_slug: 'demo',
        rule_text: '推断出的临时偏好。',
        confidence_level: 'low',
        reasoning: '单次推断',
        evidence_refs: ['s1:0'],
      }],
    })

    const db = initDatabase(home)
    const rows = db.prepare(`
      SELECT scope, project_slug, rule_text
      FROM rule_candidates
      ORDER BY rule_text
    `).all() as Array<{ scope: string; project_slug: string | null; rule_text: string }>
    db.close()

    expect(rows).toEqual([
      {
        scope: 'project',
        project_slug: 'demo',
        rule_text: '修改代码前先运行测试。',
      },
      {
        scope: 'project',
        project_slug: 'demo',
        rule_text: '修改代码前始终运行测试。',
      },
      {
        scope: 'global',
        project_slug: null,
        rule_text: '所有项目都使用中文回复。',
      },
    ])
  })

  it('只允许跨 Session 重复、重复纠正或明确记住的候选晋级', async () => {
    const thresholdEvidence: EvidenceBundle[] = [{
      projectSlug: 'demo',
      sourceSessions: ['s1', 's2'],
      roundCount: 6,
      existingRules: [],
      excerpts: [{
        locator: { sessionId: 's1', agent: 'claude', messageIndex: 0 },
        role: 'user',
        evidenceKind: 'user_signal',
        text: '修改代码前运行测试。',
        tools: [],
        frequency: 1,
      }, {
        locator: { sessionId: 's1', agent: 'claude', messageIndex: 1 },
        role: 'user',
        evidenceKind: 'user_signal',
        text: '不对，不要跳过测试，应该先运行测试。',
        tools: [],
        frequency: 1,
      }, {
        locator: { sessionId: 's1', agent: 'claude', messageIndex: 2 },
        role: 'user',
        evidenceKind: 'user_signal',
        text: '你理解错了，我说的是修改前运行测试。',
        tools: [],
        frequency: 1,
      }, {
        locator: { sessionId: 's1', agent: 'claude', messageIndex: 3 },
        role: 'user',
        evidenceKind: 'user_signal',
        text: '请记住：以后修改代码前都要运行测试。',
        tools: [],
        frequency: 1,
      }, {
        locator: { sessionId: 's1', agent: 'claude', messageIndex: 4 },
        role: 'user',
        evidenceKind: 'user_signal',
        text: 'Composer 中输入独立的 / 时应唤起 Skills Picker。',
        tools: [],
        frequency: 1,
      }, {
        locator: { sessionId: 's2', agent: 'codex', messageIndex: 0 },
        role: 'user',
        evidenceKind: 'user_signal',
        text: '先跑测试，再修改代码。',
        tools: [],
        frequency: 1,
      }],
    }]
    const candidate = (ruleText: string, evidenceRefs: string[]) => ({
      ...generated[0],
      rule_text: ruleText,
      evidence_refs: evidenceRefs,
    })

    await runRulesGenerate({ homeDir: home }, {
      extract: async () => thresholdEvidence,
      generate: async () => [
        candidate('Composer 中输入独立的 / 时应唤起 Skills Picker。', ['s1:4']),
        candidate('重复同一引用不得晋级。', ['s1:0', 's1:0']),
        candidate('同一 Session 的普通重复不得晋级。', ['s1:0', 's1:4']),
        candidate('跨 Session 重复可以晋级。', ['s1:0', 's1:0', 's2:0']),
        candidate('同一 Session 的多次纠正可以晋级。', ['s1:1', 's1:2']),
        candidate('单次纠正不得晋级。', ['s1:1']),
        candidate('明确要求记住可以晋级。', ['s1:3']),
        candidate('混入无效 locator 不得晋级。', ['s1:3', 'missing:9']),
      ],
    })

    const db = initDatabase(home)
    const rows = db.prepare(`
      SELECT rule_text, evidence_json
      FROM rule_candidates
      ORDER BY rule_text
    `).all() as Array<{ rule_text: string; evidence_json: string }>
    db.close()

    expect(rows.map((row) => row.rule_text)).toEqual([
      '同一 Session 的多次纠正可以晋级。',
      '明确要求记住可以晋级。',
      '跨 Session 重复可以晋级。',
    ])
    const crossSession = rows.find((row) => row.rule_text === '跨 Session 重复可以晋级。')
    expect(JSON.parse(crossSession?.evidence_json ?? '{}').evidence_refs).toEqual([
      's1:0',
      's2:0',
    ])
  })

  it('本次切换 Provider 时不沿用另一 Provider 的默认 model', async () => {
    fs.writeFileSync(
      path.join(resolveWorkspace(home).workspaceDir, 'config.json'),
      JSON.stringify({
        provider: 'claude',
        model: 'claude-default-model',
        effort: 'medium',
      }),
    )
    const generate = jest.fn(async (..._args: unknown[]) => generated)

    await runRulesGenerate({
      homeDir: home,
      provider: 'codex',
      effort: 'high',
      fastMode: true,
      dryRun: true,
    }, {
      extract: async () => evidence,
      generate,
    })

    expect(generate).toHaveBeenCalledWith(
      expect.any(String),
      'codex',
      undefined,
      'high',
      true,
      expect.any(Object),
    )
  })

  it('显式选择 Provider 默认 Model 时不回退到 Settings Model', async () => {
    fs.writeFileSync(
      path.join(resolveWorkspace(home).workspaceDir, 'config.json'),
      JSON.stringify({
        provider: 'claude',
        model: 'configured-sonnet',
        effort: 'medium',
      }),
    )
    const generate = jest.fn(async (..._args: unknown[]) => generated)

    await runRulesGenerate({
      homeDir: home,
      provider: 'claude',
      model: null,
      dryRun: true,
    }, {
      extract: async () => evidence,
      generate,
    })

    expect(generate).toHaveBeenCalledWith(
      expect.any(String),
      'claude',
      undefined,
      'medium',
      false,
      expect.any(Object),
    )
  })

  it('只保留真实用户证据支持且不与既有规则重复的候选', async () => {
    const qualifiedEvidence: EvidenceBundle[] = [{
      ...evidence[0],
      roundCount: 2,
      existingRules: ['Always run tests before coding.'],
      excerpts: [
        evidence[0].excerpts[0],
        {
          locator: { sessionId: 's1', agent: 'claude', messageIndex: 1 },
          role: 'assistant',
          evidenceKind: 'assistant_context',
          text: 'Always use Chinese',
          tools: [],
          frequency: 0,
        },
      ],
    }]
    const candidates = [
      {
        ...generated[0],
        rule_text: 'Always run tests before coding.',
      },
      {
        ...generated[0],
        rule_text: 'Always use Chinese',
        evidence_refs: ['s1:1'],
      },
      {
        ...generated[0],
        rule_text: 'Explain the failing test before changing code.',
      },
      {
        ...generated[0],
        rule_text: 'Invented rule',
        evidence_refs: ['missing:9'],
      },
    ]

    await runRulesGenerate({ homeDir: home }, {
      extract: async () => qualifiedEvidence,
      generate: async () => candidates,
    })

    const db = initDatabase(home)
    const rows = db.prepare('SELECT rule_text FROM rule_candidates ORDER BY rule_text').all() as Array<{ rule_text: string }>
    db.close()
    expect(rows).toEqual([
      { rule_text: 'Explain the failing test before changing code.' },
    ])
    expect(output.join('\n')).not.toContain('Always use Chinese')
    expect(output.join('\n')).not.toContain('Invented rule')
  })

  it('把指定 session 范围传给 evidence 提取', async () => {
    const extract = jest.fn(async () => evidence)

    await runRulesGenerate(
      { homeDir: home, dryRun: true, sessionIds: ['s2', 's1'] },
      { extract, generate: async () => generated },
    )

    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: ['s2', 's1'] }),
    )
  })

  it('一次提取多个项目并在 Provider 调用前发布不可变 evidence snapshot', async () => {
    const extract = jest.fn(async () => evidence)
    const snapshots: EvidenceBundle[][] = []

    await runRulesGenerate(
      {
        homeDir: home,
        dryRun: true,
        projectSlugs: ['demo', 'another'],
        onEvidence: (bundles) => snapshots.push(bundles),
      },
      { extract, generate: async () => generated },
    )

    expect(extract).toHaveBeenCalledWith(expect.objectContaining({
      projectSlugs: ['demo', 'another'],
    }))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toEqual(evidence)
  })

  it('取消发生在持久化前时不产生任何 Draft', async () => {
    const abortController = new AbortController()

    await expect(runRulesGenerate(
      {
        homeDir: home,
        signal: abortController.signal,
      },
      {
        extract: async () => {
          abortController.abort()
          return evidence
        },
        generate: async () => generated,
      },
    )).rejects.toThrow('cancelled')

    const db = initDatabase(home)
    expect((db.prepare('SELECT COUNT(*) AS count FROM rule_candidates').get() as { count: number }).count).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS count FROM llm_runs').get() as { count: number }).count).toBe(0)
    db.close()
  })

  it('每个项目完成即发布结构化 Candidate 响应', async () => {
    const projectResponses: unknown[] = []
    const secondEvidence: EvidenceBundle = {
      ...evidence[0],
      projectSlug: 'second-project',
      sourceSessions: ['s2'],
      excerpts: evidence[0].excerpts.map((excerpt) => ({
        ...excerpt,
        locator: { ...excerpt.locator, sessionId: 's2' },
      })),
    }

    await runRulesGenerate(
      {
        homeDir: home,
        dryRun: true,
        onProjectResponse: (response) => projectResponses.push(response),
      },
      {
        extract: async () => [evidence[0], secondEvidence],
        generate: jest.fn<() => Promise<typeof generated>>()
          .mockResolvedValueOnce(generated)
          .mockResolvedValueOnce([{
            ...generated[0],
            evidence_refs: ['s2:0'],
          }]),
      },
    )

    expect(projectResponses).toEqual([
      {
        projectSlug: 'demo',
        summary: expect.any(String),
        status: 'completed',
        candidates: [{
          rule: 'Always run tests',
          scope: 'project',
          confidence: 'high',
          reasoning: 'Explicit requirement',
          evidenceRefs: ['s1:0'],
        }],
      },
      {
        projectSlug: 'second-project',
        summary: expect.any(String),
        status: 'completed',
        candidates: [{
          rule: 'Always run tests',
          scope: 'project',
          confidence: 'high',
          reasoning: 'Explicit requirement',
          evidenceRefs: ['s2:0'],
        }],
      },
    ])
  })

  it('项目预览发布后取消仍不产生任何 Draft', async () => {
    const abortController = new AbortController()
    const projectResponses: unknown[] = []
    const contextsBefore = evidenceContextDirectories()

    await expect(runRulesGenerate(
      {
        homeDir: home,
        signal: abortController.signal,
        onProjectResponse: (response) => {
          projectResponses.push(response)
          abortController.abort()
        },
      },
      {
        extract: async () => evidence,
        generate: async () => generated,
      },
    )).rejects.toThrow('cancelled')

    expect(projectResponses).toHaveLength(1)
    expect(evidenceContextDirectories()).toEqual(contextsBefore)
    const db = initDatabase(home)
    expect((db.prepare('SELECT COUNT(*) AS count FROM rule_candidates').get() as { count: number }).count).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS count FROM llm_runs').get() as { count: number }).count).toBe(0)
    db.close()
  })

  it('单个项目失败时继续后续项目并持久化成功候选', async () => {
    const projectResponses: unknown[] = []
    const progress: unknown[] = []
    const bundles = ['first', 'broken', 'third'].map((projectSlug, index) => ({
      ...evidence[0],
      projectSlug,
      sourceSessions: [`s${index + 1}`],
      excerpts: evidence[0].excerpts.map((excerpt) => ({
        ...excerpt,
        locator: {
          ...excerpt.locator,
          sessionId: `s${index + 1}`,
        },
      })),
    }))
    const generate = jest.fn<() => Promise<typeof generated>>()
      .mockResolvedValueOnce(generated)
      .mockRejectedValueOnce(new Error('invalid structured output'))
      .mockResolvedValueOnce([{
        ...generated[0],
        evidence_refs: ['s3:0'],
      }])

    await expect(runRulesGenerate(
      {
        homeDir: home,
        onProgress: (value) => progress.push(value),
        onProjectResponse: (response) => projectResponses.push(response),
      },
      {
        extract: async () => bundles,
        generate,
      },
    )).resolves.toBeUndefined()

    expect(generate).toHaveBeenCalledTimes(3)
    expect(projectResponses).toEqual([
      expect.objectContaining({ projectSlug: 'first', status: 'completed' }),
      expect.objectContaining({
        projectSlug: 'broken',
        status: 'failed',
        candidates: [],
        error: 'invalid structured output',
      }),
      expect.objectContaining({ projectSlug: 'third', status: 'completed' }),
    ])
    expect(progress).toContainEqual(expect.objectContaining({
      phase: 'done',
      candidateCount: 2,
      failedProjectCount: 1,
    }))

    const db = initDatabase(home)
    expect((db.prepare('SELECT COUNT(*) AS count FROM rule_candidates').get() as { count: number }).count).toBe(2)
    expect((db.prepare('SELECT COUNT(*) AS count FROM llm_runs').get() as { count: number }).count).toBe(2)
    db.close()
  })

  it('所有项目都失败时仍把 Run 判定为失败', async () => {
    const second = {
      ...evidence[0],
      projectSlug: 'second',
    }

    await expect(runRulesGenerate(
      { homeDir: home },
      {
        extract: async () => [evidence[0], second],
        generate: async () => {
          throw new Error('provider failed')
        },
      },
    )).rejects.toThrow('所有项目生成失败（2/2）')

    const db = initDatabase(home)
    expect((db.prepare('SELECT COUNT(*) AS count FROM rule_candidates').get() as { count: number }).count).toBe(0)
    db.close()
  })
})
