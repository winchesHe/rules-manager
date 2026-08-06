import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import type { NativeChatProvider } from './chat-store.js'

export interface ChatSkill {
  name: string
  description: string
  source: 'provider' | 'shared'
}

export function listChatSkills(
  provider: NativeChatProvider,
  homeDirectory = homedir(),
): ChatSkill[] {
  const roots = [
    path.join(homeDirectory, providerSkillRoot(provider)),
    path.join(homeDirectory, '.agents/skills'),
  ]
  const skills = new Map<string, ChatSkill>()
  for (const [index, root] of roots.entries()) {
    if (!fs.existsSync(root)) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSkillName(entry.name) || skills.has(entry.name)) continue
      const skillPath = path.join(root, entry.name, 'SKILL.md')
      if (!fs.existsSync(skillPath)) continue
      skills.set(entry.name, {
        name: entry.name,
        description: readSkillDescription(skillPath),
        source: index === 0 ? 'provider' : 'shared',
      })
    }
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function providerSkillRoot(provider: NativeChatProvider): string {
  if (provider === 'claude') return '.claude/skills'
  if (provider === 'codex') return '.codex/skills'
  if (provider === 'opencode') return '.config/opencode/skills'
  return '.pi/agent/skills'
}

function isSkillName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
}

function readSkillDescription(skillPath: string): string {
  try {
    const source = fs.readFileSync(skillPath, 'utf8').slice(0, 16_384)
    const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)?.[1]
    if (!frontmatter) return ''
    const lines = frontmatter.split(/\r?\n/)
    const descriptionIndex = lines.findIndex((line) => /^description\s*:/.test(line))
    if (descriptionIndex < 0) return ''
    const value = lines[descriptionIndex].replace(/^description\s*:\s*/, '').trim()
    if (value && !/^[>|][-+]?$/u.test(value)) return cleanDescription(value)
    const folded: string[] = []
    for (const line of lines.slice(descriptionIndex + 1)) {
      if (!/^\s+/.test(line)) break
      const content = line.trim()
      if (content) folded.push(content)
    }
    return cleanDescription(folded.join(' '))
  } catch {
    return ''
  }
}

function cleanDescription(value: string): string {
  const unquoted = value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')
  return unquoted.replace(/\s+/g, ' ').trim().slice(0, 240)
}
