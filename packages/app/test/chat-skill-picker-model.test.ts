import { describe, expect, it } from '@jest/globals'
import {
  composeMessageWithSkills,
  filterChatSkills,
  orderChatSkills,
  updateRecentSkillNames,
} from '../renderer/src/views/chat-skill-picker-model.js'

const skills = [
  { name: 'flow-brainstorm', description: '梳理想法和问题', source: 'shared' as const },
  { name: 'github-workflow', description: 'Read pull requests', source: 'provider' as const },
  { name: 'grilling', description: 'Stress test a plan', source: 'shared' as const },
]

describe('chat skill picker model', () => {
  it('按名称和描述进行多词搜索', () => {
    expect(filterChatSkills(skills, 'flow 想法').map((skill) => skill.name)).toEqual(['flow-brainstorm'])
    expect(filterChatSkills(skills, 'pull').map((skill) => skill.name)).toEqual(['github-workflow'])
  })

  it('最近使用按记录排序且不在全部列表重复', () => {
    expect(orderChatSkills(skills, ['grilling', 'missing', 'flow-brainstorm'])).toEqual({
      recent: [skills[2], skills[0]],
      all: [skills[1]],
    })
  })

  it('将 UI Skill 附件组装为原生 Agent 可识别的消息前缀', () => {
    expect(composeMessageWithSkills('  帮我检查方案  ', ['grilling', 'flow-brainstorm', 'grilling']))
      .toBe('/grilling /flow-brainstorm\n\n帮我检查方案')
    expect(composeMessageWithSkills('普通消息', [])).toBe('普通消息')
  })

  it('最近使用去重、前置并限制数量', () => {
    expect(updateRecentSkillNames(['a', 'b', 'c', 'd', 'e', 'f'], ['c', 'new']))
      .toEqual(['c', 'new', 'a', 'b', 'd', 'e'])
  })
})
