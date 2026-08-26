import fs from 'node:fs'
import path from 'node:path'
import { resolveWorkspace, DEFAULT_SLUG } from './workspace.js'

const JSONL_SUFFIX = '.jsonl'

/**
 * 工作区 FS 视图写入器：symlink CRUD。
 *
 * 物理结构：
 *   <workspaceDir>/projects/<slug>/<sessionId>.jsonl  → <sourcePath>
 *
 * 安全约束（spec § 安全策略）：
 *   - linkSession 前 fs.existsSync(sourcePath) 校验
 *   - 删空目录前确认在 projectsDir 之内（防越界），且不删 default/
 */

function projectsRoot(workspaceDir: string): string {
  // 解析等价工作区根的 projectsDir，避免依赖 homeDir 解析路径。
  // 这里 workspaceDir 已经是 resolveWorkspace 输出的根，直接拼。
  return path.join(workspaceDir, 'projects')
}

function linkPath(workspaceDir: string, slug: string, sessionId: string): string {
  return path.join(projectsRoot(workspaceDir), slug, sessionId + JSONL_SUFFIX)
}

/**
 * 建立 `<projects>/<slug>/<sessionId>.jsonl` → sourcePath 的 symlink。
 * 旧 link 存在则覆盖（symlink 内容可能变），保证幂等。
 * sourcePath 不存在 → 抛错由调用方决定是否记入 errors。
 */
export function linkSession(
  workspaceDir: string,
  slug: string,
  sessionId: string,
  sourcePath: string,
): string {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`linkSession: source not found: ${sourcePath}`)
  }
  const dir = path.join(projectsRoot(workspaceDir), slug)
  fs.mkdirSync(dir, { recursive: true })
  const target = linkPath(workspaceDir, slug, sessionId)
  // 用 ln -sfn 语义：存在就覆盖。
  try {
    fs.unlinkSync(target)
  } catch {
    // 不存在就略过
  }
  fs.symlinkSync(sourcePath, target)
  return target
}

/**
 * 从 fromSlug 移到 toSlug。fromSlug == toSlug → no-op。
 * 旧目录变空且非 default → rmdir。
 */
export function moveLink(
  workspaceDir: string,
  sessionId: string,
  fromSlug: string,
  toSlug: string,
): string {
  if (fromSlug === toSlug) return linkPath(workspaceDir, toSlug, sessionId)

  const from = linkPath(workspaceDir, fromSlug, sessionId)
  const to = linkPath(workspaceDir, toSlug, sessionId)

  // 目标 slug 目录建好
  fs.mkdirSync(path.dirname(to), { recursive: true })

  // 目标 link 可能已存在（不一致状态），覆盖
  try {
    fs.unlinkSync(to)
  } catch {
    // 不存在
  }

  // 用 renameSync 移动 symlink（保留 link target 不变）
  fs.renameSync(from, to)

  removeEmptySlugDir(workspaceDir, fromSlug)
  return to
}

/**
 * 删 link；旧目录变空且非 default → rmdir。
 */
export function removeLink(workspaceDir: string, slug: string, sessionId: string): void {
  const target = linkPath(workspaceDir, slug, sessionId)
  try {
    fs.unlinkSync(target)
  } catch {
    // 不存在视为已删
  }
  removeEmptySlugDir(workspaceDir, slug)
}

/**
 * 遍历 projects/，返回 { slug → sessionId[] }。
 * 忽略 rules.md 等非 jsonl 文件。
 */
export function listLinks(workspaceDir: string): Map<string, string[]> {
  const root = projectsRoot(workspaceDir)
  const result = new Map<string, string[]>()
  if (!fs.existsSync(root)) return result

  for (const slugEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!slugEntry.isDirectory()) continue
    const slug = slugEntry.name
    const slugDir = path.join(root, slug)
    const sessionIds: string[] = []
    for (const file of fs.readdirSync(slugDir, { withFileTypes: true })) {
      if (!file.isFile() && !file.isSymbolicLink()) continue
      if (!file.name.endsWith(JSONL_SUFFIX)) continue
      const sid = file.name.slice(0, -JSONL_SUFFIX.length)
      sessionIds.push(sid)
    }
    result.set(slug, sessionIds)
  }
  return result
}

function removeEmptySlugDir(workspaceDir: string, slug: string): void {
  if (slug === DEFAULT_SLUG) return // default 永远保留
  const dir = path.join(projectsRoot(workspaceDir), slug)
  // 越界保护：必须在 projectsRoot 之内
  const root = projectsRoot(workspaceDir)
  if (!dir.startsWith(root + path.sep)) return
  try {
    const entries = fs.readdirSync(dir)
    if (entries.length === 0) fs.rmdirSync(dir)
  } catch {
    // 目录不存在 / 删除失败均忽略（FS 视图永远尽力而为）
  }
}

/**
 * 确保 projects/<DEFAULT_SLUG>/ 目录存在。init 时调用。
 */
export function ensureDefaultSlugDir(homeDir?: string): string {
  const { workspaceDir } = resolveWorkspace(homeDir)
  const dir = path.join(projectsRoot(workspaceDir), DEFAULT_SLUG)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
