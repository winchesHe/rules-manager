import Database from 'better-sqlite3'
import { resolveWorkspace } from './workspace.js'

const GENERATED_HEADER = '<!-- 此文件由 memory-manager 自动生成，手动修改会被覆盖 -->'

interface RenderedRuleRow {
  rule_text: string
}

function renderRules(
  scope: 'global' | 'project' | 'personal_style',
  homeDir?: string,
  projectSlug?: string,
): string {
  const db = new Database(resolveWorkspace(homeDir).dbPath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const rows = db.prepare(`
      SELECT rule_text
      FROM rule_candidates
      WHERE status = 'accepted'
        AND scope = ?
        AND (? IS NULL OR project_slug = ?)
      ORDER BY CASE confidence_level
        WHEN 'high' THEN 0
        WHEN 'medium' THEN 1
        WHEN 'low' THEN 2
        ELSE 3
      END, created_at, id
    `).all(scope, projectSlug ?? null, projectSlug ?? null) as RenderedRuleRow[]

    if (rows.length === 0) return ''
    const rules = rows.map(({ rule_text }) => `- ${rule_text.replaceAll('\n', '\n  ')}`).join('\n')
    return `${GENERATED_HEADER}\n\n${rules}\n`
  } finally {
    db.close()
  }
}

export function renderGlobalRules(homeDir?: string): string {
  return renderRules('global', homeDir)
}

export function renderProjectRules(projectSlug: string, homeDir?: string): string {
  return renderRules('project', homeDir, projectSlug)
}

export function renderStyleRules(homeDir?: string): string {
  return renderRules('personal_style', homeDir)
}
