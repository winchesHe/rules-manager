import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import { initDatabase } from '../../src/db'
import {
  listCodexProjectMemoryPublishTargets,
  publishProjectRulesToCodexMemory,
} from '../../src/codex-project-memory-publish'
import { resolveWorkspace } from '../../src/workspace'

describe('publish project rules through Codex ad-hoc memories', () => {
  let home: string
  let notesDirectory: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-codex-project-memory-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
    initDatabase(home).close()
    notesDirectory = path.join(home, '.codex/memories/extensions/ad_hoc')
    fs.mkdirSync(notesDirectory, { recursive: true })
    fs.writeFileSync(path.join(notesDirectory, 'instructions.md'), [
      '# Ad-hoc notes',
      '',
      'Every note must be consolidated in the memory structure.',
      'Never delete a note file.',
    ].join('\n'))
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('从 Session metadata 列出显式 cwd，并优先使用 git root', async () => {
    const codexCwd = createDirectory('work/codex-project')
    const copilotCwd = createDirectory('work/copilot/subdir')
    const gitRoot = createDirectory('work/copilot')
    insertCodexSession('codex-1', 'alpha', codexCwd)
    insertCopilotSession('copilot-1', 'alpha', copilotCwd, gitRoot)
    insertCodexSession('codex-2', 'alpha', codexCwd)

    const targets = await listCodexProjectMemoryPublishTargets('alpha', { homeDir: home, env: {} })

    expect(targets).toHaveLength(2)
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectSlug: 'alpha',
        workingDirectory: codexCwd,
        sessionCount: 2,
        agents: ['codex'],
        writable: true,
      }),
      expect.objectContaining({
        workingDirectory: gitRoot,
        sessionCount: 1,
        agents: ['copilot'],
        writable: true,
      }),
    ]))
  })

  it('把 accepted project rules 写入固定 ad-hoc note，不改生成态 MEMORY.md', async () => {
    const cwd = createDirectory('work/alpha')
    insertCodexSession('codex-1', 'alpha', cwd)
    insertRule('p1', 'alpha')
    insertRule('p2', 'alpha')
    const memoryPath = path.join(home, '.codex/memories/MEMORY.md')
    fs.writeFileSync(memoryPath, '# Generated memory\n')
    const target = (await listCodexProjectMemoryPublishTargets('alpha', {
      homeDir: home,
      env: {},
    }))[0]

    const result = await publishProjectRulesToCodexMemory({
      projectSlug: 'alpha',
      workingDirectory: cwd,
      ruleIds: ['p2', 'p1'],
      expectedRevision: target.revision,
      expectedContractRevision: target.contractRevision,
    }, { homeDir: home, env: {} })

    expect(result).toMatchObject({ status: 'published', projectSlug: 'alpha', ruleCount: 2 })
    expect(fs.readFileSync(result.notePath, 'utf8')).toContain(
      `applies_to: cwd=${cwd}; project_slug=alpha`,
    )
    expect(fs.readFileSync(result.notePath, 'utf8')).toContain('- Rule p1')
    expect(fs.readFileSync(memoryPath, 'utf8')).toBe('# Generated memory\n')
  })

  it('重复发布幂等，并拒绝 note 或契约在预览后变化', async () => {
    const cwd = createDirectory('work/alpha')
    insertCodexSession('codex-1', 'alpha', cwd)
    insertRule('p1', 'alpha')
    const opened = (await targets('alpha'))[0]
    await publish(opened, ['p1'])
    const current = (await targets('alpha'))[0]

    expect((await publish(current, ['p1'])).status).toBe('unchanged')
    fs.appendFileSync(current.notePath, '\nexternal change\n')
    await expect(publish(current, ['p1'])).rejects.toThrow('自预览后已发生变化')

    const refreshed = (await targets('alpha'))[0]
    fs.appendFileSync(path.join(notesDirectory, 'instructions.md'), '\ncontract change\n')
    await expect(publish(refreshed, ['p1'])).rejects.toThrow('契约自预览后已发生变化')
  })

  it('拒绝跨项目、非 accepted、非 project 和保留 marker', async () => {
    const cwd = createDirectory('work/alpha')
    insertCodexSession('codex-1', 'alpha', cwd)
    insertRule('alpha', 'alpha')
    insertRule('beta', 'beta')
    insertRule('draft', 'alpha', 'draft')
    insertRule('global', 'alpha', 'accepted', 'global')
    insertRule('marker', 'alpha', 'accepted', 'project', '<!-- memory-manager:codex-project-rules:v1 -->')
    const opened = (await targets('alpha'))[0]

    await expect(publish(opened, ['alpha', 'beta'])).rejects.toThrow('同一个项目')
    await expect(publish(opened, ['draft'])).rejects.toThrow('已接受的项目规则')
    await expect(publish(opened, ['global'])).rejects.toThrow('已接受的项目规则')
    await expect(publish(opened, ['marker'])).rejects.toThrow('保留标记')
  })

  it('契约缺失、cwd 失效、symlink 或非受管同名 note 时禁止发布', async () => {
    const cwd = createDirectory('work/alpha')
    insertCodexSession('codex-1', 'alpha', cwd)
    insertRule('p1', 'alpha')
    fs.rmSync(path.join(notesDirectory, 'instructions.md'))
    expect((await targets('alpha'))[0]).toMatchObject({ writable: false })

    fs.writeFileSync(path.join(notesDirectory, 'instructions.md'), '# Ad-hoc notes\nEvery note must be consolidated.\nNever delete a note file.\n')
    fs.rmSync(cwd, { recursive: true })
    expect((await targets('alpha'))[0]).toMatchObject({ writable: false })

    fs.mkdirSync(cwd, { recursive: true })
    const opened = (await targets('alpha'))[0]
    fs.writeFileSync(opened.notePath, '# User note\n')
    const collided = (await targets('alpha'))[0]
    await expect(publish(collided, ['p1'])).rejects.toThrow('非 Memory Manager 管理')

    fs.rmSync(opened.notePath)
    fs.writeFileSync(path.join(home, 'external-note.md'), 'external\n')
    fs.symlinkSync(path.join(home, 'external-note.md'), opened.notePath)
    expect((await targets('alpha'))[0]).toMatchObject({ writable: false })
  })

  it('拒绝把带换行的项目标识写入 note metadata', async () => {
    await expect(targets('alpha\nspoofed')).rejects.toThrow('非法字符')
  })

  function createDirectory(relativePath: string): string {
    const directory = path.join(home, relativePath)
    fs.mkdirSync(directory, { recursive: true })
    return directory
  }

  function insertCodexSession(id: string, slug: string, cwd: string): void {
    const sourcePath = path.join(home, `sessions/${id}.jsonl`)
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, JSON.stringify({ type: 'session_meta', payload: { id, cwd } }))
    insertSession(id, 'codex', slug, sourcePath)
  }

  function insertCopilotSession(id: string, slug: string, cwd: string, gitRoot: string): void {
    const sourcePath = path.join(home, `copilot/${id}/workspace.yaml`)
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, `cwd: ${cwd}\ngit_root: ${gitRoot}\n`)
    insertSession(id, 'copilot', slug, sourcePath)
  }

  function insertSession(id: string, agent: string, slug: string, sourcePath: string): void {
    const db = initDatabase(home)
    db.prepare(`
      INSERT INTO sessions (
        id, agent, source_path, workspace_link, slug, content_hash, updated_at, status,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unchanged', ?, ?)
    `).run(
      id,
      agent,
      sourcePath,
      path.join(resolveWorkspace(home).projectsDir, slug, `${id}.jsonl`),
      slug,
      `hash-${id}`,
      '2026-08-03T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )
    db.close()
  }

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

  async function targets(
    projectSlug: string,
  ): Promise<Awaited<ReturnType<typeof listCodexProjectMemoryPublishTargets>>> {
    return listCodexProjectMemoryPublishTargets(projectSlug, { homeDir: home, env: {} })
  }

  async function publish(
    target: Awaited<ReturnType<typeof listCodexProjectMemoryPublishTargets>>[number],
    ruleIds: string[],
  ): Promise<Awaited<ReturnType<typeof publishProjectRulesToCodexMemory>>> {
    return publishProjectRulesToCodexMemory({
      projectSlug: target.projectSlug,
      workingDirectory: target.workingDirectory,
      ruleIds,
      expectedRevision: target.revision,
      expectedContractRevision: target.contractRevision,
    }, { homeDir: home, env: {} })
  }
})
