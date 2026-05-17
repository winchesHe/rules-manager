import path from 'node:path'
import type {
  ProjectClassification,
  ProjectHint,
  ProjectHintKind,
} from './types.js'
import { UNKNOWN_PROJECT_KEY } from './types.js'

// 评分优先级（plan 04 文档 30-44 行）：
//   git_root > cwd > source_project_path > message_path > branch
// branch 不能单独决定项目（plan 04 第 46 行）。
const KIND_PRIORITY: Record<ProjectHintKind, number> = {
  git_root: 5,
  cwd: 4,
  source_project_path: 3,
  message_path: 2,
  git_remote: 1,
  branch: 0,
}

const STANDALONE_DECIDABLE: ReadonlySet<ProjectHintKind> = new Set<ProjectHintKind>([
  'git_root',
  'cwd',
  'source_project_path',
  'message_path',
])

const CURSOR_HEURISTIC_TAIL_SEGMENTS = 3

function pickBestHint(hints: ProjectHint[]): ProjectHint | null {
  let best: ProjectHint | null = null
  for (const h of hints) {
    if (!STANDALONE_DECIDABLE.has(h.kind)) continue
    if (!best) {
      best = h
      continue
    }
    const pa = KIND_PRIORITY[h.kind]
    const pb = KIND_PRIORITY[best.kind]
    if (pa > pb) {
      best = h
    } else if (pa === pb && h.confidence > best.confidence) {
      best = h
    }
  }
  return best
}

/**
 * 把 hint.value 转成 project_key。
 * - cwd / git_root / message_path：path.basename 直接拿最后一段。
 * - source_project_path（cursor lossy 编码 `Users-...-Desktop-...-Project-Name`）：
 *   无损反解不可能；启发式取最后 N=3 段（fixture-driven 妥协，留给 R2 的
 *   `projects assign` 人工修正）。如果总段数 < N，则取全部段拼回。
 */
export function projectKeyFromHint(hint: ProjectHint): string | null {
  if (hint.kind === 'cwd' || hint.kind === 'git_root' || hint.kind === 'message_path') {
    const base = path.basename(hint.value)
    return base || null
  }
  if (hint.kind === 'source_project_path') {
    const segs = hint.value.split('-').filter(Boolean)
    if (segs.length === 0) return null
    return segs.slice(-CURSOR_HEURISTIC_TAIL_SEGMENTS).join('-')
  }
  return null
}

export function classifyHints(hints: ProjectHint[]): ProjectClassification {
  const best = pickBestHint(hints)
  if (!best) {
    return {
      projectKey: UNKNOWN_PROJECT_KEY,
      confidence: 0,
      decisionHint: null,
    }
  }
  const key = projectKeyFromHint(best)
  if (!key) {
    return {
      projectKey: UNKNOWN_PROJECT_KEY,
      confidence: 0,
      decisionHint: best,
    }
  }
  return {
    projectKey: key,
    confidence: best.confidence,
    decisionHint: best,
  }
}
