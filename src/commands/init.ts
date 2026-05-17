import fs from 'node:fs'
import * as clack from '@clack/prompts'
import pc from 'picocolors'
import { resolveWorkspace } from '../workspace.js'
import { initDatabase } from '../db.js'
import { ensureDefaultSlugDir } from '../fs-writer.js'

export interface InitOptions {
  yes: boolean
  homeDir?: string
}

export async function runInit(opts: InitOptions): Promise<void> {
  const { workspaceDir, rulesDir, sourcesDir } = resolveWorkspace(opts.homeDir)

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

  try {
    spinner?.start('正在初始化工作区…')

    // 目录（幂等）：workspaceDir / rules / sources / projects/default
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.mkdirSync(rulesDir, { recursive: true })
    fs.mkdirSync(sourcesDir, { recursive: true })
    ensureDefaultSlugDir(opts.homeDir)

    // 初始化 DB（幂等）
    const db = initDatabase(opts.homeDir)
    db.close()

    spinner?.stop('工作区初始化完成')
  } catch (err) {
    spinner?.stop('初始化失败')
    throw err
  }

  if (opts.yes) {
    console.log(pc.green('✓') + ' 工作区已就绪：' + workspaceDir)
  } else {
    clack.outro(pc.green('初始化完成'))
  }
}
