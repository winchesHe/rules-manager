import { describe, expect, it } from '@jest/globals'
import type { AutoMemorySource } from '../renderer/src/types'
import {
  groupAutoMemoryProjects,
  partitionAutoMemorySources,
} from '../renderer/src/views/auto-memory-projects'

function source(
  agent: 'claude' | 'codex',
  id: string,
  scope: 'project' | 'global',
  projectPath?: string,
  modifiedAt = '2026-08-04T09:00:00.000Z',
): AutoMemorySource {
  return {
    id,
    agent,
    scope,
    path: agent === 'codex' ? '/home/.codex/memories/MEMORY.md' : `/home/.claude/${id}/MEMORY.md`,
    format: 'markdown',
    status: 'present',
    discoveredFrom: 'filesystem',
    projectPath,
    modifiedAt,
    sizeBytes: 100,
  }
}

describe('Agent Memory project view model', () => {
  it('同一真实路径的 Claude 与 Codex 来源归为一个项目', () => {
    const claude = source('claude', 'project:encoded', 'project', '/work/alpha')
    const codex = source('codex', 'project:hash', 'project', '/work/alpha')

    expect(groupAutoMemoryProjects([claude, codex])).toEqual([{
      projectPath: '/work/alpha',
      projectName: 'alpha',
      sources: [claude, codex],
      modifiedAt: '2026-08-04T09:00:00.000Z',
    }])
  })

  it('全局来源不进入项目列表，未提供 projectPath 的项目来源进入待关联', () => {
    const global = source('codex', 'memory', 'global')
    const unresolved = source('claude', 'project:opaque', 'project')
    const linked = source('codex', 'project:linked', 'project', '/work/linked')

    expect(groupAutoMemoryProjects([global, unresolved, linked])).toHaveLength(1)
    expect(partitionAutoMemorySources([global, unresolved, linked])).toEqual({
      claudeProjectFiles: [unresolved],
      codexGlobalFiles: [global],
      codexProjectScopes: [linked],
      unresolvedProjectSources: [unresolved],
    })
  })

  it('项目按最近修改时间降序排列，时间相同再按名称排列', () => {
    const older = source('codex', 'older', 'project', '/work/zeta', '2026-08-03T09:00:00.000Z')
    const alpha = source('codex', 'alpha', 'project', '/work/alpha')
    const beta = source('codex', 'beta', 'project', '/work/beta')

    expect(groupAutoMemoryProjects([older, beta, alpha]).map((project) => project.projectName))
      .toEqual(['alpha', 'beta', 'zeta'])
  })
})
