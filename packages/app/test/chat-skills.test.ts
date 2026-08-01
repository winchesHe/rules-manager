import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from '@jest/globals'
import { listChatSkills } from '../main/chat-skills.js'

const roots: string[] = []

describe('chat skills', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('按 Provider 合并通用与专属 Skill，只返回可插入名称', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-chat-skills-'))
    roots.push(home)
    for (const directory of [
      path.join(home, '.agents/skills/shared'),
      path.join(home, '.claude/skills/claude-only'),
      path.join(home, '.codex/skills/codex-only'),
      path.join(home, '.codex/skills/shared'),
    ]) {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'SKILL.md'), '# Skill\n')
    }
    fs.mkdirSync(path.join(home, '.claude/skills/not-a-skill'), { recursive: true })

    expect(listChatSkills('claude', home)).toEqual([
      { name: 'claude-only' }, { name: 'shared' },
    ])
    expect(listChatSkills('codex', home)).toEqual([
      { name: 'codex-only' }, { name: 'shared' },
    ])
  })
})
