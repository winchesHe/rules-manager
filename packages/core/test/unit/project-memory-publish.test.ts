import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../../src/db'
import {
  inspectClaudeProjectMemoryPublication,
  listClaudeProjectMemoryPublishTargets,
  publishProjectRulesToClaudeMemory,
} from '../../src/project-memory-publish'
import { resolveWorkspace } from '../../src/workspace'

describe('publish project rules to Claude auto memory', () => {
  let home: string
  let memoryPath: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-project-memory-publish-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
    initDatabase(home).close()
    memoryPath = path.join(home, '.claude/projects/opaque-project/memory/MEMORY.md')
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true })
    fs.writeFileSync(memoryPath, '# Claude notes\n\n- Existing learning\n')
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function insertRule(
    id: string,
    projectSlug: string,
    status = 'accepted',
    scope = 'project',
    ruleText = `Rule ${id}`,
  ): void {
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO rule_candidates (
        id, scope, project_slug, rule_text, confidence_level, status,
        evidence_json, source_sessions, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'high', ?, '{}', '[]', ?, ?)
    `).run(
      id,
      scope,
      projectSlug,
      ruleText,
      status,
      '2026-08-03T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )
    db.close()
  }

  function target() {
    return listClaudeProjectMemoryPublishTargets({ homeDir: home, env: {} })[0]
  }

  it('把显式选择的同项目 accepted rules 写入受管索引和独立 topic', () => {
    insertRule('p1', 'rules-manager')
    insertRule('p2', 'rules-manager')
    const opened = target()

    const result = publishProjectRulesToClaudeMemory({
      memoryId: opened.memoryId,
      ruleIds: ['p2', 'p1'],
      expectedRevision: opened.revision,
      expectedTopicRevision: opened.topicRevision,
    }, home, {})

    expect(result).toMatchObject({
      status: 'published',
      projectSlug: 'rules-manager',
      ruleCount: 2,
    })
    const memory = fs.readFileSync(memoryPath, 'utf8')
    const topic = fs.readFileSync(result.topicPath, 'utf8')
    expect(memory.startsWith('<!-- memory-manager:project-rules:start -->')).toBe(true)
    expect(memory).toContain('Rule p1')
    expect(memory).toContain('Rule p2')
    expect(memory).toContain('# Claude notes')
    expect(memory).toContain('- Existing learning')
    expect(topic).toContain('memory-manager:project-rules:topic')
    expect(topic).toContain('项目：`rules-manager`')
  })

  it('重复发布保持 unchanged，更新时只替换 Memory Manager 受管内容', () => {
    insertRule('p1', 'rules-manager')
    const first = target()
    publishProjectRulesToClaudeMemory({
      memoryId: first.memoryId,
      ruleIds: ['p1'],
      expectedRevision: first.revision,
      expectedTopicRevision: first.topicRevision,
    }, home, {})
    const afterFirst = target()

    const repeated = publishProjectRulesToClaudeMemory({
      memoryId: afterFirst.memoryId,
      ruleIds: ['p1'],
      expectedRevision: afterFirst.revision,
      expectedTopicRevision: afterFirst.topicRevision,
    }, home, {})

    expect(repeated.status).toBe('unchanged')
    expect(fs.readFileSync(memoryPath, 'utf8').match(/project-rules:start/g)).toHaveLength(1)
  })

  it('按全部 accepted project rules 判断未发布、已同步和有更新', () => {
    insertRule('p1', 'rules-manager')
    expect(inspectClaudeProjectMemoryPublication('rules-manager', home, {}))
      .toMatchObject({ status: 'not_published', acceptedRuleCount: 1 })

    const opened = target()
    publishProjectRulesToClaudeMemory({
      memoryId: opened.memoryId,
      ruleIds: ['p1'],
      expectedRevision: opened.revision,
      expectedTopicRevision: opened.topicRevision,
    }, home, {})
    expect(inspectClaudeProjectMemoryPublication('rules-manager', home, {}))
      .toMatchObject({
        status: 'synced',
        targets: [expect.objectContaining({ status: 'synced', label: '~/opaque-project' })],
      })

    insertRule('p2', 'rules-manager')
    expect(inspectClaudeProjectMemoryPublication('rules-manager', home, {}))
      .toMatchObject({ status: 'outdated', acceptedRuleCount: 2 })
  })

  it('项目没有 accepted rules 时返回 no_rules 且不读取目标内容', () => {
    expect(inspectClaudeProjectMemoryPublication('rules-manager', home, {}))
      .toEqual({
        agent: 'claude',
        projectSlug: 'rules-manager',
        acceptedRuleCount: 0,
        status: 'no_rules',
        targets: [],
      })
  })

  it('拒绝 Memory 或 topic 在预览后发生变化', () => {
    insertRule('p1', 'rules-manager')
    const beforeMemoryChange = target()
    fs.appendFileSync(memoryPath, '\n- Claude concurrent edit\n')
    expect(() => publishProjectRulesToClaudeMemory({
      memoryId: beforeMemoryChange.memoryId,
      ruleIds: ['p1'],
      expectedRevision: beforeMemoryChange.revision,
      expectedTopicRevision: beforeMemoryChange.topicRevision,
    }, home, {})).toThrow('Memory 自预览后已发生变化')

    const current = target()
    const topicPath = path.join(path.dirname(memoryPath), 'memory-manager-rules.md')
    fs.writeFileSync(topicPath, '<!-- memory-manager:project-rules:topic -->\nexternal edit\n')
    expect(() => publishProjectRulesToClaudeMemory({
      memoryId: current.memoryId,
      ruleIds: ['p1'],
      expectedRevision: current.revision,
      expectedTopicRevision: current.topicRevision,
    }, home, {})).toThrow('topic 自预览后已发生变化')
  })

  it('拒绝跨项目、非 accepted、非 project 和未知规则', () => {
    insertRule('p1', 'one')
    insertRule('p2', 'two')
    insertRule('draft', 'one', 'draft')
    insertRule('global', 'one', 'accepted', 'global')
    insertRule('marker', 'one', 'accepted', 'project', '<!-- memory-manager:project-rules:end -->')
    const opened = target()
    const request = {
      memoryId: opened.memoryId,
      expectedRevision: opened.revision,
      expectedTopicRevision: opened.topicRevision,
    }

    expect(() => publishProjectRulesToClaudeMemory({ ...request, ruleIds: ['p1', 'p2'] }, home, {}))
      .toThrow('同一个项目')
    expect(() => publishProjectRulesToClaudeMemory({ ...request, ruleIds: ['draft'] }, home, {}))
      .toThrow('已接受的项目规则')
    expect(() => publishProjectRulesToClaudeMemory({ ...request, ruleIds: ['global'] }, home, {}))
      .toThrow('已接受的项目规则')
    expect(() => publishProjectRulesToClaudeMemory({ ...request, ruleIds: ['missing'] }, home, {}))
      .toThrow('部分候选规则不存在')
    expect(() => publishProjectRulesToClaudeMemory({ ...request, ruleIds: ['marker'] }, home, {}))
      .toThrow('保留标记')
  })

  it('拒绝 symlink Memory 和非受管的同名 topic', () => {
    insertRule('p1', 'rules-manager')
    const targetPath = path.join(home, 'external/MEMORY.md')
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.renameSync(memoryPath, targetPath)
    fs.symlinkSync(targetPath, memoryPath)
    expect(target()).toMatchObject({ writable: false })
    expect(inspectClaudeProjectMemoryPublication('rules-manager', home, {}))
      .toMatchObject({ status: 'unavailable' })

    fs.rmSync(memoryPath)
    fs.copyFileSync(targetPath, memoryPath)
    fs.writeFileSync(path.join(path.dirname(memoryPath), 'memory-manager-rules.md'), '# User file\n')
    const opened = target()
    expect(() => publishProjectRulesToClaudeMemory({
      memoryId: opened.memoryId,
      ruleIds: ['p1'],
      expectedRevision: opened.revision,
      expectedTopicRevision: opened.topicRevision,
    }, home, {})).toThrow('非 Memory Manager 管理的 topic')
  })

  it('target revisions 与当前文件 hash 一致', () => {
    const opened = target()
    expect(opened.displayName).toBe('~/opaque-project')
    expect(opened.revision).toBe(
      crypto.createHash('sha256').update(fs.readFileSync(memoryPath)).digest('hex'),
    )
    expect(opened.topicRevision).toBeNull()
  })
})
