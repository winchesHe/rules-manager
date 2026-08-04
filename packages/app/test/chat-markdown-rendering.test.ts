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
    expect(source).toContain('<MarkdownMessage content={item.content} final={final}')
    expect(source).toContain('<MarkdownMessage content={assistantContent} final />')
    expect(source).toContain('batchRendering={false}')
    expect(source).toContain('deferNodesUntilVisible={false}')
    expect(source).toContain('renderCodeBlocksAsPre')
    expect(source).toContain("break-words whitespace-pre-wrap`}>{message.content}</p>")
    expect(source).toContain('data-chat-message-attachments')
  })

  it('载入 Markstream 样式并用应用主题 token 约束正文和宽内容', () => {
    const styles = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8')

    expect(styles).toContain('@import "markstream-react/index.css"')
    expect(styles).toContain('.chat-markdown .markstream-react')
    expect(styles).toContain('--foreground: var(--theme-foreground)')
    expect(styles).toContain(':where(pre, .table-node-wrapper)')
  })

  it('旧消息无法恢复原始 Timeline 时先展示 Tool、最后展示结论', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'views/ChatView.tsx'), 'utf8')
    const legacyTools = source.indexOf(
      '<ToolActivityList activities={message.toolActivities ?? []}',
    )
    const legacyConclusion = source.indexOf(
      '<MarkdownMessage content={message.content} final />',
      legacyTools,
    )

    expect(legacyTools).toBeGreaterThan(-1)
    expect(legacyConclusion).toBeGreaterThan(legacyTools)
  })
})
