const SESSION_AGENTS = new Set(['claude', 'codex', 'copilot', 'cursor', 'opencode', 'pi'])

export function validateSessionReferences(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error('session context selected must be an array')
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('session context reference is invalid')
    }
    const reference = item as Record<string, unknown>
    if (!SESSION_AGENTS.has(String(reference.agent))) {
      throw new Error('session context agent is unsupported')
    }
    if (typeof reference.id !== 'string' || !reference.id.trim()) {
      throw new Error('session context id is required')
    }
    return { agent: String(reference.agent), id: reference.id }
  })
}
