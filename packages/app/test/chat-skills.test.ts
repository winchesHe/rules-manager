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
      fs.writeFileSync(path.join(directory, 'SKILL.md'), [
        '---',
        `description: Description for ${path.basename(directory)}`,
        '---',
        '# Skill',
      ].join('\n'))
    }
    fs.mkdirSync(path.join(home, '.claude/skills/not-a-skill'), { recursive: true })

    expect(listChatSkills('claude', home)).toEqual([
      { name: 'claude-only', description: 'Description for claude-only', source: 'provider' },
      { name: 'shared', description: 'Description for shared', source: 'shared' },
    ])
    expect(listChatSkills('codex', home)).toEqual([
      { name: 'codex-only', description: 'Description for codex-only', source: 'provider' },
      { name: 'shared', description: 'Description for shared', source: 'provider' },
    ])
  })

  it('只读取 frontmatter 描述并兼容折叠块', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-chat-skills-'))
    roots.push(home)
    const directory = path.join(home, '.agents/skills/folded')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'SKILL.md'), [
      '---',
      'description: >-',
      '  Search and select',
      '  useful context.',
      '---',
      'THIS BODY MUST NOT BECOME A DESCRIPTION',
    ].join('\n'))

    expect(listChatSkills('claude', home)).toEqual([{
      name: 'folded',
      description: 'Search and select useful context.',
      source: 'shared',
    }])
  })
})
