import path from 'node:path'

export interface CodexMemoryTaskGroup {
  title: string
  scope: string | null
  appliesTo: string
  projectPaths: string[]
  content: string
}

export interface CodexProjectMemory {
  projectPath: string
  projectName: string
  taskGroupCount: number
  content: string
}

const TASK_GROUP_HEADING = /^# Task Group:\s*(.+?)\s*$/gm

function parseProjectPaths(appliesTo: string): string[] {
  const cwd = appliesTo.match(/(?:^|;)\s*cwd=([^;]+)/)?.[1]
  if (!cwd) return []

  const paths = cwd
    .split(/\s+(?:and|or)\s+/i)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith('/') && candidate !== '/')
    .map((candidate) => path.normalize(candidate))

  return [...new Set(paths)]
}

export function parseCodexMemoryTaskGroups(content: string): CodexMemoryTaskGroup[] {
  const headings = [...content.matchAll(TASK_GROUP_HEADING)]
  const groups: CodexMemoryTaskGroup[] = []

  for (const [index, heading] of headings.entries()) {
    const start = heading.index ?? 0
    const end = headings[index + 1]?.index ?? content.length
    const block = content.slice(start, end).trimEnd()
    const appliesTo = block.match(/^applies_to:\s*(.+?)\s*$/m)?.[1]
    if (!appliesTo) continue

    const projectPaths = parseProjectPaths(appliesTo)
    if (projectPaths.length === 0) continue

    groups.push({
      title: heading[1].trim(),
      scope: block.match(/^scope:\s*(.+?)\s*$/m)?.[1] ?? null,
      appliesTo,
      projectPaths,
      content: block,
    })
  }

  return groups
}

export function parseCodexProjectMemories(content: string): CodexProjectMemory[] {
  const projects = new Map<string, CodexMemoryTaskGroup[]>()

  for (const group of parseCodexMemoryTaskGroups(content)) {
    for (const projectPath of group.projectPaths) {
      const existing = projects.get(projectPath)
      if (existing) existing.push(group)
      else projects.set(projectPath, [group])
    }
  }

  return [...projects.entries()].map(([projectPath, groups]) => ({
    projectPath,
    projectName: path.basename(projectPath),
    taskGroupCount: groups.length,
    content: groups.map((group) => group.content).join('\n\n'),
  }))
}
