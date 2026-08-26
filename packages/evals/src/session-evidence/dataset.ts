import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalAgent, SessionEvidenceEvalCase } from './types.js'

interface ManifestCase {
  caseId: string
  requestText: string
  expectedMode: 'complete' | 'targeted'
  sessionCount: number
  relevantSessionIndexes: number[]
  goldFactSessionIndexes: number[]
  unavailableSessionIndexes?: number[]
  readFailedSessionIndexes?: number[]
  tags: string[]
}

interface Manifest {
  datasetVersion: string
  generatorVersion: number
  cases: ManifestCase[]
}

const AGENTS: EvalAgent[] = ['claude', 'codex', 'copilot', 'cursor', 'opencode', 'pi']

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function loadSessionEvidenceDataset(): SessionEvidenceEvalCase[] {
  const directory = path.dirname(fileURLToPath(import.meta.url))
  const manifestPath = path.resolve(directory, '../../fixtures/session-evidence/manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest
  return manifest.cases.map((item) => {
    const selected = Array.from({ length: item.sessionCount }, (_, index) => ({
      agent: AGENTS[index % AGENTS.length],
      id: `${item.caseId}-session-${index}`,
    }))
    const messages = Object.fromEntries(selected.map((reference, index) => [
      reference.id,
      [`人工脱敏 fixture：${item.caseId} 的 Session ${index}。`],
    ]))
    const goldFacts = item.goldFactSessionIndexes.map((index) => ({
      id: `${item.caseId}-fact-${index}`,
      acceptableLocators: [{
        sessionId: selected[index].id,
        agent: selected[index].agent,
        messageIndex: 0,
      }],
    }))
    const hashInput = { datasetVersion: manifest.datasetVersion, generatorVersion: manifest.generatorVersion, item }
    return {
      caseId: item.caseId,
      caseHash: stableHash(hashInput),
      requestText: item.requestText,
      expectedMode: item.expectedMode,
      selected,
      messages,
      goldRelevantSessionIds: item.relevantSessionIndexes.map((index) => selected[index].id),
      goldFacts,
      unavailableSessionIds: (item.unavailableSessionIndexes ?? []).map((index) => selected[index].id),
      readFailedSessionIds: (item.readFailedSessionIndexes ?? []).map((index) => selected[index].id),
      forbiddenClaims: ['已读取所有 Session 且没有遗漏'],
      tags: [...item.tags],
    }
  })
}
