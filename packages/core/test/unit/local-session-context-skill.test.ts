import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const skillRoot = path.resolve(coreRoot, '../../.agents/skills/local-session-context')

describe('local-session-context Skill', () => {
  it('frontmatter 覆盖两个触发场景且正文锁定 coverage、全量 part 与 close', () => {
    const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8')

    expect(skill).not.toContain('TODO')
    expect(skill).toContain('computer-use')
    expect(skill).toContain('chrome-use')
    expect(skill).toContain('全量读取最近一段时间的 Session')
    expect(skill).toContain('coverage.unknown > 0')
    expect(skill).toContain('part=1..partCount')
    expect(skill).toContain('readParts=expectedParts')
    expect(skill).toContain('context close <runId>')
    expect(skill).toContain('references/cli-contract.md')
  })

  it('reference 提供工具 OR/AND、最近 7 天全量配方和 coverage 恒等式', () => {
    const reference = fs.readFileSync(path.join(skillRoot, 'references/cli-contract.md'), 'utf8')

    expect(reference).toContain('工具或关键词任一命中')
    expect(reference).toContain('使用过工具且提到指定问题')
    expect(reference).toContain('"lastDays": 7')
    expect(reference).toContain('不要添加 `where`')
    expect(reference).toContain('candidates = inspected + unknown')
    expect(reference).toContain('inspected = matched + notMatched')
    expect(reference).toContain('system/platform/Skill catalog 不参与')
  })

  it('agents/openai.yaml 与 Skill 名称和默认触发提示一致', () => {
    const metadata = parseYaml(
      fs.readFileSync(path.join(skillRoot, 'agents/openai.yaml'), 'utf8'),
    ) as {
      interface: {
        display_name: string
        short_description: string
        default_prompt: string
      }
    }

    expect(metadata.interface.display_name).toBe('本地 Session 上下文')
    expect(metadata.interface.short_description.length).toBeGreaterThanOrEqual(25)
    expect(metadata.interface.default_prompt).toContain('$local-session-context')
  })
})
