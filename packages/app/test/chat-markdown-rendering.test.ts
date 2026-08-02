import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@jest/globals'

const rendererRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../renderer/src',
)

describe('Chat Markdown rendering', () => {
  it('历史、流式与 Rules Assistant 共用 Markstream，用户消息保持纯文本', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'views/ChatView.tsx'), 'utf8')

    expect(source).toContain("import MarkdownRender from 'markstream-react'")
    expect(source).toContain('<MarkdownMessage content={message.content} final />')
    expect(source).toContain('<MarkdownMessage content={assistant} final={false} />')
    expect(source).toContain('<MarkdownMessage content={assistantContent} final />')
    expect(source).toContain('renderCodeBlocksAsPre')
    expect(source).toContain('<p className="break-words whitespace-pre-wrap">{message.content}</p>')
  })

  it('载入 Markstream 样式并用应用主题 token 约束正文和宽内容', () => {
    const styles = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8')

    expect(styles).toContain('@import "markstream-react/index.css"')
    expect(styles).toContain('.chat-markdown .markstream-react')
    expect(styles).toContain('--foreground: var(--theme-foreground)')
    expect(styles).toContain(':where(pre, .table-node-wrapper)')
  })
})
