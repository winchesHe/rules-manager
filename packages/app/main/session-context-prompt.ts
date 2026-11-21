import type { NativeSessionReference } from './chat-store.js'

const AGENTS = new Set([
  'claude', 'codex', 'copilot', 'cursor', 'gemini', 'grok', 't3', 'antigravity', 'opencode', 'pi',
])

export function buildSessionContextPrompt(input: {
  revision: number
  selected: NativeSessionReference[]
  previous: NativeSessionReference[]
}): string {
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new Error('session context revision must be positive')
  }
  const selected = canonicalReferences(input.selected)
  const previous = canonicalReferences(input.previous)
  const selectedKeys = new Set(selected.map(referenceKey))
  const previousKeys = new Set(previous.map(referenceKey))
  const added = selected.filter((reference) => !previousKeys.has(referenceKey(reference)))
  const removed = previous.filter((reference) => !selectedKeys.has(referenceKey(reference)))
  return [
    `<host_session_context version="1" revision="${input.revision}" mode="replace">`,
    '  <selected>',
    ...selected.flatMap((reference) => [
      `    <session agent="${reference.agent}" id="${reference.id}">`,
      `      <command>memory-manager sessions show ${reference.id} --stream</command>`,
      '    </session>',
    ]),
    '  </selected>',
    `  <added>${inlineReferences(added)}</added>`,
    `  <removed>${inlineReferences(removed)}</removed>`,
    '</host_session_context>',
  ].join('\n')
}

export function canonicalReferences(
  references: NativeSessionReference[],
): NativeSessionReference[] {
  const unique = new Map<string, NativeSessionReference>()
  for (const reference of references) {
    if (!AGENTS.has(reference.agent)) throw new Error('session context agent is unsupported')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(reference.id)) {
      throw new Error('session context id is invalid')
    }
    unique.set(referenceKey(reference), { agent: reference.agent, id: reference.id })
  }
  return [...unique.values()].sort((left, right) =>
    left.agent.localeCompare(right.agent) || left.id.localeCompare(right.id),
  )
}

function inlineReferences(references: NativeSessionReference[]): string {
  return references
    .map((reference) => `<session agent="${reference.agent}" id="${reference.id}" />`)
    .join('')
}

function referenceKey(reference: NativeSessionReference): string {
  return `${reference.agent}\0${reference.id}`
}
