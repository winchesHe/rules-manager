import fs from 'node:fs'
import path from 'node:path'
import * as clack from '@clack/prompts'
import pc from 'picocolors'
import { resolveWorkspace } from '../workspace.js'
import { initDatabase } from '../db.js'

export interface InitOptions {
  yes: boolean
  homeDir?: string
}

export async function runInit(opts: InitOptions): Promise<void> {
  const { workspaceDir, projectsDir } = resolveWorkspace(opts.homeDir)

  if (!opts.yes) {
    clack.intro(pc.cyan('memory-manager init'))
    const confirmed = await clack.confirm({
      message: `初始化工作区到 ${workspaceDir}？`,
      initialValue: true,
    })
    if (clack.isCancel(confirmed) || !confirmed) {
      clack.outro(pc.yellow('已取消'))
      process.exit(0)
    }
  }

  const spinner = opts.yes ? null : clack.spinner()
  spinner?.start('正在初始化工作区…')

  // 创建目录（幂等）
  fs.mkdirSync(projectsDir, { recursive: true })

  // 初始化 DB（幂等）
  const db = initDatabase(opts.homeDir)
  db.close()

  spinner?.stop('工作区初始化完成')

  if (opts.yes) {
    console.log(pc.green('✓') + ' 工作区已就绪：' + workspaceDir)
  } else {
    clack.outro(pc.green('初始化完成'))
  }
}
