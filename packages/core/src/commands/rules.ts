import {
  isAgentName,
  listGlobalInstructionSources,
  showGlobalInstructionSource,
  type GlobalInstructionListOptions,
} from '../global-instructions.js'

export function runRulesList(
  agent?: string,
  options: Omit<GlobalInstructionListOptions, 'agent'> = {},
): void {
  if (agent !== undefined && !isAgentName(agent)) {
    throw new Error(`未知 agent：${agent}`)
  }
  const result = listGlobalInstructionSources({ ...options, agent })
  console.log(JSON.stringify(result, null, 2))
}

export function runRulesShow(
  agent: string,
  options: Omit<GlobalInstructionListOptions, 'agent'> = {},
): void {
  if (!isAgentName(agent)) throw new Error(`未知 agent：${agent}`)
  const result = showGlobalInstructionSource(agent, options)
  console.log(JSON.stringify(result, null, 2))
}
