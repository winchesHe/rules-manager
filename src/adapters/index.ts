import type { AgentAdapter, AgentName } from '../types.js'
import { claudeAdapter } from './claude.js'
import { codexAdapter } from './codex.js'
import { copilotAdapter } from './copilot.js'
import { cursorAdapter } from './cursor.js'

export const ALL_ADAPTERS: AgentAdapter[] = [
  claudeAdapter,
  codexAdapter,
  copilotAdapter,
  cursorAdapter,
]

const ADAPTER_MAP = new Map<AgentName, AgentAdapter>(
  ALL_ADAPTERS.map((a) => [a.name, a]),
)

export function getAdapters(names: AgentName[]): AgentAdapter[] {
  const unknown = names.filter((n) => !ADAPTER_MAP.has(n))
  if (unknown.length > 0) {
    const noun = unknown.length === 1 ? 'agent' : 'agents'
    const available = ALL_ADAPTERS.map((a) => a.name).join(', ')
    throw new Error(
      `Unknown ${noun}: ${unknown.join(', ')} (available: ${available})`,
    )
  }
  return names.map((name) => ADAPTER_MAP.get(name)!)
}
