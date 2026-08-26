import type { AutoMemorySource } from '../types'

export interface AutoMemoryProjectGroup {
  projectPath: string
  projectName: string
  sources: AutoMemorySource[]
  modifiedAt: string | null
}

export interface AutoMemorySourcePartitions {
  claudeProjectFiles: AutoMemorySource[]
  codexGlobalFiles: AutoMemorySource[]
  codexProjectScopes: AutoMemorySource[]
  unresolvedProjectSources: AutoMemorySource[]
}

function projectName(projectPath: string): string {
  const segments = projectPath.split('/').filter(Boolean)
  return segments.at(-1) ?? projectPath
}

function latestModifiedAt(sources: AutoMemorySource[]): string | null {
  return sources.reduce<string | null>((latest, source) => {
    if (!source.modifiedAt) return latest
    if (!latest || source.modifiedAt > latest) return source.modifiedAt
    return latest
  }, null)
}

function compareSources(left: AutoMemorySource, right: AutoMemorySource): number {
  return left.agent.localeCompare(right.agent, 'en')
    || left.id.localeCompare(right.id, 'en')
}

export function groupAutoMemoryProjects(
  sources: AutoMemorySource[],
): AutoMemoryProjectGroup[] {
  const grouped = new Map<string, AutoMemorySource[]>()
  for (const source of sources) {
    if (source.scope !== 'project' || !source.projectPath) continue
    const existing = grouped.get(source.projectPath)
    if (existing) existing.push(source)
    else grouped.set(source.projectPath, [source])
  }

  return [...grouped.entries()]
    .map(([projectPath, projectSources]) => ({
      projectPath,
      projectName: projectName(projectPath),
      sources: [...projectSources].sort(compareSources),
      modifiedAt: latestModifiedAt(projectSources),
    }))
    .sort((left, right) => {
      const modified = (right.modifiedAt ?? '').localeCompare(left.modifiedAt ?? '', 'en')
      return modified || left.projectName.localeCompare(right.projectName, 'en')
    })
}

export function partitionAutoMemorySources(
  sources: AutoMemorySource[],
): AutoMemorySourcePartitions {
  return {
    claudeProjectFiles: sources.filter((source) =>
      source.agent === 'claude' && source.scope === 'project'),
    codexGlobalFiles: sources.filter((source) =>
      source.agent === 'codex' && source.scope === 'global'),
    codexProjectScopes: sources.filter((source) =>
      source.agent === 'codex' && source.scope === 'project'),
    unresolvedProjectSources: sources.filter((source) =>
      source.scope === 'project' && !source.projectPath),
  }
}
