import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runRulesOutput } from '../../src/commands/rules-output'
import { initDatabase } from '../../src/db'
import { resolveWorkspace } from '../../src/workspace'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tsxCli = path.resolve(projectRoot, '../../node_modules/tsx/dist/cli.mjs')

describe('rules output', () => {
  let home: string
  let output: string[]
  let originalLog: typeof console.log

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-rules-output-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir, { recursive: true })
    initDatabase(home).close()
    output = []
    originalLog = console.log
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '))
  })

  afterEach(() => {
    console.log = originalLog
    fs.rmSync(home, { recursive: true, force: true })
  })

  function insertAccepted(
    id: string,
    scope: 'global' | 'project' | 'personal_style',
    ruleText: string,
    projectSlug?: string,
  ): void {
    const db = initDatabase(home)
    const now = '2026-07-27T00:00:00.000Z'
    db.prepare(`
      INSERT INTO rule_candidates (
        id, scope, project_slug, rule_text, confidence_level, status,
        evidence_json, source_sessions, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'high', 'accepted', '{}', '[]', ?, ?)
    `).run(id, scope, projectSlug ?? null, ruleText, now, now)
    db.close()
  }

  it('相同内容第二次 output 报未变化且不重写文件', () => {
    insertAccepted('global', 'global', 'Run tests')
    const target = path.join(resolveWorkspace(home).rulesDir, 'global.md')

    runRulesOutput({ global: true, homeDir: home })
    const firstStat = fs.statSync(target)
    output = []
    runRulesOutput({ global: true, homeDir: home })

    expect(output.join('\n')).toContain('未变化')
    expect(fs.statSync(target).mtimeMs).toBe(firstStat.mtimeMs)
  })

  it('dry-run 打印路径和预览但不创建 rules 目录', () => {
    insertAccepted('global', 'global', 'Run tests')
    const rulesDir = resolveWorkspace(home).rulesDir

    runRulesOutput({ global: true, dryRun: true, homeDir: home })

    expect(output.join('\n')).toContain(path.join(rulesDir, 'global.md'))
    expect(output.join('\n')).toContain('Run tests')
    expect(fs.existsSync(rulesDir)).toBe(false)
  })

  it('atomic write 完成后不残留 .tmp 文件', () => {
    insertAccepted('global', 'global', 'Run tests')

    runRulesOutput({ global: true, homeDir: home })

    const rulesDir = resolveWorkspace(home).rulesDir
    expect(fs.readFileSync(path.join(rulesDir, 'global.md'), 'utf8')).toContain('Run tests')
    expect(fs.readdirSync(rulesDir).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('指定 project 时只写对应项目文件', () => {
    insertAccepted('demo', 'project', 'Use demo command', 'demo')
    insertAccepted('other', 'project', 'Use other command', 'other')

    runRulesOutput({ project: 'demo', homeDir: home })

    const rulesDir = resolveWorkspace(home).rulesDir
    const target = path.join(rulesDir, 'projects', 'demo.md')
    expect(fs.readFileSync(target, 'utf8')).toContain('Use demo command')
    expect(fs.readFileSync(target, 'utf8')).not.toContain('Use other command')
    expect(fs.existsSync(path.join(rulesDir, 'projects', 'other.md'))).toBe(false)
    expect(fs.existsSync(path.join(rulesDir, 'global.md'))).toBe(false)
  })

  it('--all 端到端输出三种 scope 且第二次全部未变化', () => {
    insertAccepted('global', 'global', 'Global only')
    insertAccepted('project', 'project', 'Project only', 'demo')
    insertAccepted('style', 'personal_style', 'Style only')

    runRulesOutput({ all: true, homeDir: home })

    const rulesDir = resolveWorkspace(home).rulesDir
    const global = fs.readFileSync(path.join(rulesDir, 'global.md'), 'utf8')
    const project = fs.readFileSync(path.join(rulesDir, 'projects', 'demo.md'), 'utf8')
    const style = fs.readFileSync(path.join(rulesDir, 'personal-style.md'), 'utf8')
    expect(global).toContain('自动生成')
    expect(global).toContain('Global only')
    expect(global).not.toContain('Project only')
    expect(project).toContain('Project only')
    expect(project).not.toContain('Global only')
    expect(style).toContain('Style only')

    output = []
    runRulesOutput({ all: true, homeDir: home })
    expect(output).toHaveLength(3)
    expect(output.every((line) => line.includes('未变化'))).toBe(true)
  })

  it('CLI 注册 rules output 并显示全部选项', () => {
    const result = spawnSync(
      process.execPath,
      [tsxCli, 'src/cli.ts', 'rules', 'output', '--help'],
      { cwd: projectRoot, encoding: 'utf8' },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--project <slug>')
    expect(result.stdout).toContain('--global')
    expect(result.stdout).toContain('--style')
    expect(result.stdout).toContain('--all')
    expect(result.stdout).toContain('--dry-run')
  })
})
