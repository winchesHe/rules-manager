import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const WORKSPACE_DIR = path.join(os.homedir(), '.memory-manager')

export function resolveWorkspace(homeDir?: string): {
  workspaceDir: string
  dbPath: string
  rulesDir: string
  projectsDir: string
  sourcesDir: string
} {
  const base = homeDir ? path.join(homeDir, '.memory-manager') : WORKSPACE_DIR
  return {
    workspaceDir: base,
    dbPath: path.join(base, 'memory.db'),
    // rules/ 留给 Plan 07 输出 rule 文件用（保留 init 建好）
    rulesDir: path.join(base, 'rules'),
    // FS-first 分类视图根：<workspace>/projects/<slug>/<sid>.jsonl
    projectsDir: path.join(base, 'projects'),
    // adapter 数据源根（用户软链到 ~/.claude 等）
    sourcesDir: path.join(base, 'sources'),
  }
}

export function workspaceExists(homeDir?: string): boolean {
  const { workspaceDir } = resolveWorkspace(homeDir)
  return fs.existsSync(workspaceDir)
}

export const DEFAULT_SLUG = 'default'
