import { describe, expect, it } from '@jest/globals'
import { buildSessionContextPrompt } from '../main/session-context-prompt.js'

describe('buildSessionContextPrompt', () => {
  it('输出完整 replace、精确 --stream 命令与相对上次成功注入的净变化', () => {
    expect(buildSessionContextPrompt({
      revision: 3,
      selected: [
        { agent: 'codex', id: '019fdef' },
        { agent: 'claude', id: '019fabc' },
      ],
      previous: [
        { agent: 'claude', id: '019fabc' },
        { agent: 'opencode', id: 'ses_old' },
      ],
    })).toBe(`<host_session_context version="1" revision="3" mode="replace">
  <selected>
    <session agent="claude" id="019fabc">
      <command>memory-manager sessions show 019fabc --stream</command>
    </session>
    <session agent="codex" id="019fdef">
      <command>memory-manager sessions show 019fdef --stream</command>
    </session>
  </selected>
  <added><session agent="codex" id="019fdef" /></added>
  <removed><session agent="opencode" id="ses_old" /></removed>
</host_session_context>`)
  })

  it('清空选择仍产生空 selected 和完整 removed', () => {
    expect(buildSessionContextPrompt({
      revision: 4, selected: [], previous: [{ agent: 'codex', id: 'session-1' }],
    })).toContain(`  <selected>
  </selected>
  <added></added>
  <removed><session agent="codex" id="session-1" /></removed>`)
  })
})
