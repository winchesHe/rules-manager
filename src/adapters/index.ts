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
  return names.map((name) => {
    const adapter = ADAPTER_MAP.get(name)
    if (!adapter) throw new Error(`Unknown agent: ${name}`)
    return adapter
  })
}
