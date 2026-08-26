export interface ChatSkillOption {
  name: string
  description: string
  source: 'provider' | 'shared'
}

const RECENT_SKILL_LIMIT = 6

export function filterChatSkills(
  skills: ChatSkillOption[],
  query: string,
): ChatSkillOption[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return skills
  return skills.filter((skill) => {
    const searchable = `${skill.name} ${skill.description}`.toLocaleLowerCase()
    return terms.every((term) => searchable.includes(term))
  })
}

export function orderChatSkills(
  skills: ChatSkillOption[],
  recentNames: string[],
): { recent: ChatSkillOption[]; all: ChatSkillOption[] } {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const recent = recentNames.flatMap((name) => {
    const skill = byName.get(name)
    return skill ? [skill] : []
  })
  const recentSet = new Set(recent.map((skill) => skill.name))
  return { recent, all: skills.filter((skill) => !recentSet.has(skill.name)) }
}

export function composeMessageWithSkills(message: string, selectedNames: string[]): string {
  const commands = [...new Set(selectedNames)].map((name) => `/${name}`).join(' ')
  return commands ? `${commands}\n\n${message.trim()}` : message.trim()
}

export function updateRecentSkillNames(current: string[], used: string[]): string[] {
  const usedUnique = [...new Set(used)]
  const usedSet = new Set(usedUnique)
  return [...usedUnique, ...current.filter((name) => !usedSet.has(name))]
    .slice(0, RECENT_SKILL_LIMIT)
}

export function consumeSkillPickerTrigger(value: string): {
  composer: string
  triggered: boolean
} {
  if (!/(^|\s)\/$/.test(value)) return { composer: value, triggered: false }
  return { composer: value.slice(0, -1), triggered: true }
}
