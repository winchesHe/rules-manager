import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { normalizeSlug } from '../classifier.js'
import {
  renderGlobalRules,
  renderProjectRules,
  renderStyleRules,
} from '../renderer.js'
import { resolveWorkspace } from '../workspace.js'

export interface RulesOutputOptions {
  project?: string
  global?: boolean
  style?: boolean
  all?: boolean
  dryRun?: boolean
  homeDir?: string
}

interface OutputTarget {
  path: string
  content: string
}

function listAcceptedProjectSlugs(homeDir?: string): string[] {
  const db = new Database(resolveWorkspace(homeDir).dbPath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const rows = db.prepare(`
      SELECT DISTINCT project_slug
      FROM rule_candidates
      WHERE status = 'accepted' AND scope = 'project' AND project_slug IS NOT NULL
      ORDER BY project_slug
    `).all() as Array<{ project_slug: string }>
    return rows.map(({ project_slug }) => project_slug)
  } finally {
    db.close()
  }
}

function validateProjectSlug(slug: string): void {
  if (normalizeSlug(slug) !== slug) {
    throw new Error(`无效的 project slug：${slug}`)
  }
}

function writeAtomic(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporaryPath, content, 'utf8')
    fs.renameSync(temporaryPath, targetPath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath)
  }
}

export function runRulesOutput(options: RulesOutputOptions): void {
  if (!options.all && !options.global && !options.style && !options.project) {
    throw new Error('请指定 --project、--global、--style 或 --all')
  }

  const { rulesDir } = resolveWorkspace(options.homeDir)
  const targets: OutputTarget[] = []

  if (options.all || options.global) {
    targets.push({
      path: path.join(rulesDir, 'global.md'),
      content: renderGlobalRules(options.homeDir),
    })
  }
  if (options.all || options.style) {
    targets.push({
      path: path.join(rulesDir, 'personal-style.md'),
      content: renderStyleRules(options.homeDir),
    })
  }

  const projectSlugs = new Set<string>()
  if (options.project) projectSlugs.add(options.project)
  if (options.all) {
    for (const slug of listAcceptedProjectSlugs(options.homeDir)) projectSlugs.add(slug)
  }
  for (const slug of projectSlugs) {
    validateProjectSlug(slug)
    targets.push({
      path: path.join(rulesDir, 'projects', `${slug}.md`),
      content: renderProjectRules(slug, options.homeDir),
    })
  }

  for (const target of targets) {
    if (options.dryRun) {
      console.log(`将写入：${target.path}\n${target.content}`)
      continue
    }
    if (fs.existsSync(target.path) && fs.readFileSync(target.path, 'utf8') === target.content) {
      console.log(`未变化：${target.path}`)
      continue
    }
    writeAtomic(target.path, target.content)
    console.log(`已写入：${target.path}`)
  }
}
