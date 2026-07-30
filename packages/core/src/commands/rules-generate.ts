import { createHash, randomUUID } from 'node:crypto'
import {
  isLlmEffort,
  loadLlmConfig,
  type LlmEffort,
  type LlmProvider,
} from '../config.js'
import { initDatabase } from '../db.js'
import { extractEvidence, type EvidenceBundle } from '../evidence.js'
import { candidateRulesSchema, getStructuredResponse, type CandidateRule } from '../llm.js'
import { throwIfAborted } from '../abort.js'
import type { LlmStreamEvent } from '../llm.js'

export interface GenerateProgress {
  phase: 'extracting' | 'generating' | 'splitting' | 'done'
  current?: number
  total?: number
  projectSlug?: string
  candidateCount?: number
}

export interface ProjectGenerationCandidate {
  rule: string
  scope: CandidateRule['scope']
  confidence: CandidateRule['confidence_level']
  reasoning: string
  evidenceRefs: string[]
}

export interface ProjectGenerationResponse {
  projectSlug: string
  summary: string
  candidates: ProjectGenerationCandidate[]
}

export interface RulesGenerateOptions {
  homeDir?: string
  runId?: string
  dryRun?: boolean
  project?: string
  projectSlugs?: string[]
  provider?: LlmProvider
  model?: string
  effort?: LlmEffort
  fastMode?: boolean
  rounds?: number
  full?: boolean
  sessionIds?: string[]
  signal?: AbortSignal
  onProgress?: (progress: GenerateProgress) => void
  onEvidence?: (bundles: EvidenceBundle[]) => void
  onLlmEvent?: (event: LlmStreamEvent) => void
  onProjectResponse?: (response: ProjectGenerationResponse) => void
}

interface RulesGenerateDeps {
  extract?: (options: RulesGenerateOptions) => Promise<EvidenceBundle[]>
  generate?: (
    prompt: string,
    provider: LlmProvider,
    model?: string,
    effort?: LlmEffort,
    fastMode?: boolean,
  ) => Promise<CandidateRule[]>
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function generationPrompt(bundle: EvidenceBundle): string {
  return [
    '根据 evidence 提取可复用的 agent 规则候选。',
    '置信度判断框架：high=明确要求、重复纠正或硬约束；medium=至少两次偏好或稳定项目事实；low=单次推断。',
    'frequency 表示同一项目不同 session 出现相同表述的次数，必须纳入置信度判断。',
    'evidence_refs 必须引用 locator，不能编造 evidence。',
    JSON.stringify(bundle),
  ].join('\n')
}

function isPromptTooLong(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return msg.includes('too long') || msg.includes('too_long') || msg.includes('token') || msg.includes('context length') || msg.includes('json 解析失败')
}

function splitBundle(bundle: EvidenceBundle): EvidenceBundle[] {
  const mid = Math.ceil(bundle.excerpts.length / 2)
  const left: EvidenceBundle = { ...bundle, excerpts: bundle.excerpts.slice(0, mid) }
  const right: EvidenceBundle = { ...bundle, excerpts: bundle.excerpts.slice(mid) }
  return [left, right]
}

type GenerateFn = (
  prompt: string,
  provider: LlmProvider,
  model?: string,
  effort?: LlmEffort,
  fastMode?: boolean,
) => Promise<CandidateRule[]>

async function generateWithAutoSplit(
  bundle: EvidenceBundle,
  generate: GenerateFn,
  provider: LlmProvider,
  model: string | undefined,
  effort: LlmEffort | undefined,
  fastMode: boolean | undefined,
  onProgress?: (progress: GenerateProgress) => void,
  signal?: AbortSignal,
  onLlmEvent?: (event: LlmStreamEvent) => void,
  depth = 0,
): Promise<CandidateRule[]> {
  const MAX_SPLIT_DEPTH = 4
  const prompt = generationPrompt(bundle)
  try {
    throwIfAborted(signal)
    if (depth > 0) {
      process.stderr.write(`  ⏳ 请求中（${bundle.excerpts.length} excerpts，层级 ${depth}）...\n`)
    }
    const result = generate === getDefaultGenerate
      ? await getStructuredResponse(
          prompt,
          candidateRulesSchema,
          provider,
          model,
          effort,
          { fastMode, signal, onEvent: onLlmEvent },
        )
      : await generate(prompt, provider, model, effort, fastMode)
    throwIfAborted(signal)
    if (depth > 0) {
      process.stderr.write(`  ✓ 返回 ${result.length} 条候选\n`)
    }
    return result
  } catch (error) {
    if (!isPromptTooLong(error) || bundle.excerpts.length <= 1 || depth >= MAX_SPLIT_DEPTH) {
      throw error
    }
    const halves = splitBundle(bundle)
    process.stderr.write(`⚠ prompt 过长（${bundle.excerpts.length} excerpts），拆分为 ${halves[0].excerpts.length} + ${halves[1].excerpts.length} 分别请求\n`)
    onProgress?.({
      phase: 'splitting',
      projectSlug: bundle.projectSlug,
    })
    const results: CandidateRule[] = []
    for (const half of halves) {
      const partial = await generateWithAutoSplit(
        half,
        generate,
        provider,
        model,
        effort,
        fastMode,
        onProgress,
        signal,
        onLlmEvent,
        depth + 1,
      )
      results.push(...partial)
    }
    return results
  }
}

const getDefaultGenerate: GenerateFn = async () => {
  throw new Error('default generator marker should not be called directly')
}

export async function runRulesGenerate(
  opts: RulesGenerateOptions = {},
  deps: RulesGenerateDeps = {},
): Promise<void> {
  const config = loadLlmConfig(opts.homeDir)
  const provider = opts.provider ?? config.provider
  const model = opts.model ?? config.model
  const effort = opts.effort ?? config.effort
  const fastMode = opts.fastMode ?? config.fastMode ?? false
  throwIfAborted(opts.signal)
  if (provider !== 'claude' && provider !== 'codex') {
    throw new Error('provider 只支持 claude 或 codex')
  }
  if (!isLlmEffort(effort)) {
    throw new Error('effort 只支持 low、medium、high、xhigh 或 max')
  }
  if (model !== undefined && model.trim() === '') throw new Error('model 不能是空字符串')
  opts.onProgress?.({ phase: 'extracting' })
  const bundles = await (deps.extract ?? extractEvidence)({
    homeDir: opts.homeDir,
    projectSlug: opts.project,
    projectSlugs: opts.projectSlugs,
    sessionIds: opts.sessionIds,
    rounds: opts.rounds,
    full: opts.full,
    signal: opts.signal,
  })
  throwIfAborted(opts.signal)
  opts.onEvidence?.(bundles)
  opts.onProgress?.({ phase: 'extracting', current: bundles.length, total: bundles.length })
  if (bundles.length === 0) {
    process.stderr.write('⚠ 没有可用的 evidence bundle，跳过生成\n')
    opts.onProgress?.({ phase: 'done', candidateCount: 0 })
    return
  }
  process.stderr.write(`✓ 提取完成，${bundles.length} 个 bundle，开始调用 ${provider} 生成规则...\n`)
  const generated: Array<{ bundle: EvidenceBundle; prompt: string; candidates: CandidateRule[] }> = []
  let candidateCount = 0
  for (let i = 0; i < bundles.length; i++) {
    throwIfAborted(opts.signal)
    const bundle = bundles[i]
    process.stderr.write(`⏳ 生成 ${i + 1}/${bundles.length}（${bundle.projectSlug}，${bundle.excerpts.length} excerpts）...\n`)
    opts.onProgress?.({
      phase: 'generating',
      current: i + 1,
      total: bundles.length,
      projectSlug: bundle.projectSlug,
      candidateCount,
    })
    const generate: GenerateFn = deps.generate ?? getDefaultGenerate
    const candidates = await generateWithAutoSplit(
      bundle,
      generate,
      provider,
      model,
      effort,
      fastMode,
      opts.onProgress,
      opts.signal,
      opts.onLlmEvent,
    )
    candidateCount += candidates.length
    process.stderr.write(`✓ 生成 ${i + 1}/${bundles.length} 完成，${candidates.length} 条候选\n`)
    opts.onProgress?.({
      phase: 'generating',
      current: i + 1,
      total: bundles.length,
      projectSlug: bundle.projectSlug,
      candidateCount,
    })
    generated.push({ bundle, prompt: generationPrompt(bundle), candidates })
    opts.onProjectResponse?.({
      projectSlug: bundle.projectSlug,
      summary: candidates.length === 0
        ? `No reusable rule candidates were found for ${bundle.projectSlug}.`
        : `Generated ${candidates.length} rule candidate${candidates.length === 1 ? '' : 's'} for ${bundle.projectSlug}.`,
      candidates: candidates.map((candidate) => ({
        rule: candidate.rule_text,
        scope: candidate.scope,
        confidence: candidate.confidence_level,
        reasoning: candidate.reasoning,
        evidenceRefs: [...candidate.evidence_refs],
      })),
    })
  }

  if (!opts.dryRun) {
    throwIfAborted(opts.signal)
    const db = initDatabase(opts.homeDir)
    try {
      const insertCandidate = db.prepare(`
        INSERT INTO rule_candidates (
          id, scope, project_slug, rule_text, confidence_level, evidence_json,
          source_sessions, created_at, updated_at, run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertRun = db.prepare(`
        INSERT INTO llm_runs (
          id, task, model, input_hash, output_hash, status, token_usage_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const persist = db.transaction(() => {
        throwIfAborted(opts.signal)
        for (const item of generated) {
          throwIfAborted(opts.signal)
          const now = new Date().toISOString()
          for (const candidate of item.candidates) {
            insertCandidate.run(
              randomUUID(),
              candidate.scope,
              candidate.project_slug ?? (candidate.scope === 'project' ? item.bundle.projectSlug : null),
              candidate.rule_text,
              candidate.confidence_level,
              JSON.stringify({
                bundle: item.bundle,
                reasoning: candidate.reasoning,
                evidence_refs: candidate.evidence_refs,
              }),
              JSON.stringify(item.bundle.sourceSessions),
              now,
              now,
              opts.runId ?? null,
            )
          }
          insertRun.run(
            randomUUID(),
            'rules-generate',
            model ?? `${provider}:default`,
            sha256(item.prompt),
            sha256(JSON.stringify(item.candidates)),
            'success',
            null,
            now,
          )
        }
      })
      persist()
    } finally {
      db.close()
    }
  }

  console.log(JSON.stringify({
    dryRun: Boolean(opts.dryRun),
    provider,
    model: model ?? null,
    candidates: generated.flatMap((item) => item.candidates),
  }, null, 2))
  opts.onProgress?.({ phase: 'done', candidateCount })
}
