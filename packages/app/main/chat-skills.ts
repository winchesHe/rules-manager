import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import type { NativeChatProvider } from './chat-store.js'

export interface ChatSkill {
  name: string
}

export function listChatSkills(
  provider: NativeChatProvider,
  homeDirectory = homedir(),
): ChatSkill[] {
  const roots = [
    path.join(homeDirectory, provider === 'claude' ? '.claude/skills' : '.codex/skills'),
    path.join(homeDirectory, '.agents/skills'),
  ]
  const names = new Set<string>()
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSkillName(entry.name)) continue
      if (fs.existsSync(path.join(root, entry.name, 'SKILL.md'))) names.add(entry.name)
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right)).map((name) => ({ name }))
}

function isSkillName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
}
