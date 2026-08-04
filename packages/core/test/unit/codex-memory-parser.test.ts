import { describe, expect, it } from '@jest/globals'
import {
  parseCodexMemoryTaskGroups,
  parseCodexProjectMemories,
} from '../../src/codex-memory-parser'

describe('Codex MEMORY.md project parser', () => {
  it('按 applies_to cwd 聚合同一项目的多个 Task Group，并保持原始顺序', () => {
    const content = `preamble
# Task Group: First

scope: first scope
applies_to: cwd=/work/alpha; reuse_rule=first

## Task 1
first body

# Task Group: Second

scope: second scope
applies_to: cwd=/work/beta or /work/alpha; reuse_rule=second

## Task 1
second body
`

    expect(parseCodexMemoryTaskGroups(content)).toEqual([
      expect.objectContaining({
        title: 'First',
        scope: 'first scope',
        projectPaths: ['/work/alpha'],
      }),
      expect.objectContaining({
        title: 'Second',
        scope: 'second scope',
        projectPaths: ['/work/beta', '/work/alpha'],
      }),
    ])
    expect(parseCodexProjectMemories(content)).toEqual([
      {
        projectPath: '/work/alpha',
        projectName: 'alpha',
        taskGroupCount: 2,
        content: expect.stringMatching(/First[\s\S]*first body[\s\S]*Second[\s\S]*second body/),
      },
      {
        projectPath: '/work/beta',
        projectName: 'beta',
        taskGroupCount: 1,
        content: expect.stringContaining('# Task Group: Second'),
      },
    ])
  })

  it('忽略没有 applies_to、没有 cwd、相对路径和描述性附加范围', () => {
    const content = `# Task Group: No applies
scope: ignored

# Task Group: Global
applies_to: reuse_rule=global

# Task Group: Relative
applies_to: cwd=repo/local; reuse_rule=ignored

# Task Group: Descriptive suffix
applies_to: cwd=/work/alpha and MoeGo checkouts; reuse_rule=only explicit path
`

    expect(parseCodexProjectMemories(content)).toEqual([{
      projectPath: '/work/alpha',
      projectName: 'alpha',
      taskGroupCount: 1,
      content: expect.stringContaining('Descriptive suffix'),
    }])
  })

  it('规范化并去重同一 Task Group 中重复的绝对 cwd', () => {
    const content = `# Task Group: Duplicate
applies_to: cwd=/work/alpha/../alpha and /work/alpha; reuse_rule=dedupe
`

    expect(parseCodexProjectMemories(content)).toEqual([{
      projectPath: '/work/alpha',
      projectName: 'alpha',
      taskGroupCount: 1,
      content: expect.stringContaining('# Task Group: Duplicate'),
    }])
  })
})
