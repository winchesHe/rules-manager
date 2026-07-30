import path from 'node:path'
import type { ProjectHint, ProjectHintKind } from './types.js'
import { DEFAULT_SLUG } from './workspace.js'

// 评分优先级：git_root > cwd > source_project_path > message_path > git_remote > branch
// branch 只做辅助，不单独决定（来自 spec § 接口设计与 classifier 子系统）。
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

// cursor source_project_path 是 lossy 编码（`/`、`-`、`_` 都映射为 `-`），
// 无损反解不可能；启发式取最后 N 段（fixture-driven）。
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
    if (pa > pb) best = h
    else if (pa === pb && h.confidence > best.confidence) best = h
  }
  return best
}

function rawSlugFromHint(hint: ProjectHint): string | null {
  if (hint.kind === 'cwd' || hint.kind === 'git_root' || hint.kind === 'message_path') {
    return path.basename(hint.value) || null
  }
  if (hint.kind === 'source_project_path') {
    const segs = hint.value.split('-').filter(Boolean)
    if (segs.length === 0) return null
    return segs.slice(-CURSOR_HEURISTIC_TAIL_SEGMENTS).join('-')
  }
  return null
}

/**
 * slug 归一化：只允许 [a-z0-9-]，开头结尾去 `-`，空串 → DEFAULT_SLUG。
 * 防 path 注入（含 `..` / `/` 等被消除为 `-`）。
 */
export function normalizeSlug(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_SLUG
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || DEFAULT_SLUG
}

/**
 * 输入 hints → 输出归一化后的 slug。
 * 没有 standalone-decidable hint / 提取失败 → DEFAULT_SLUG（兜底，物理上落 projects/default/）。
 */
export function classify(hints: ProjectHint[]): string {
  const best = pickBestHint(hints)
  if (!best) return DEFAULT_SLUG
  const raw = rawSlugFromHint(best)
  return normalizeSlug(raw)
}
