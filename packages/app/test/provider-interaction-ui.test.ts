import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'

const rendererRoot = path.resolve(process.cwd(), 'renderer/src')
const read = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8')

describe('OpenCode / Pi Provider UI 合同', () => {
  it('Chat 把原生 question 渲染为可回答卡片并经 IPC 回传', () => {
    const source = read('views/ChatView.tsx')
    expect(source).toContain("event.type === 'interaction_request'")
    expect(source).toContain('pendingInteraction.request.questions.map')
    expect(source).toContain("'chat.interaction.respond'")
    expect(source).toContain('respondToInteraction(true)')
    expect(source).toContain('respondToInteraction()')
  })

  it('设置页为四个 Provider 提供可区分图标，Fast 标签只列 Claude/Codex', () => {
    const source = read('views/SettingsView.tsx')
    expect(source).toContain("provider === 'claude'")
    expect(source).toContain("provider === 'opencode'")
    expect(source).toContain("provider === 'pi'")
    expect(source).toContain('Claude · Codex')
  })
})
