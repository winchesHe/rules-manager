import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runScan } from '../../src/scanner'
import { runSessionQuery } from '../../src/session-query'
import { readSessionEventSources } from '../../src/session-events'
import { readSessionSources } from '../../src/session-source-reader'
import { runSessionsShow } from '../../src/commands/sessions'
import { resolveWorkspace } from '../../src/workspace'

describe('T3、Antigravity 与 Grok 的统一会话', () => {
  const native = 'de000001-0000-4000-8000-000000000001'
  const grok = 'de000002-0000-4000-8000-000000000002'
  let home: string
  let log: string
  let db: Database.Database
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-sessions-'))
    fs.mkdirSync(resolveWorkspace(home).workspaceDir)
    const t3 = path.join(home, '.t3/userdata')
    fs.mkdirSync(t3, { recursive: true })
    db = new Database(path.join(t3, 'statev2.sqlite'))
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, created_at, updated_at, deleted_at);
      CREATE TABLE orchestration_v2_projection_messages (thread_id, message_id, role, created_at, payload_json, updated_at);
      CREATE TABLE orchestration_v2_projection_provider_threads (thread_id, provider, payload_json);
      CREATE TABLE projection_projects (project_id, workspace_root);
      INSERT INTO projection_projects VALUES ('project','/tmp/project');
      INSERT INTO orchestration_v2_projection_threads VALUES ('host','project','宿主标题','grok','1','2',NULL);
      INSERT INTO orchestration_v2_projection_messages VALUES ('host','1','user','1','{"createdBy":"agent","text":"宿主代发"}','1');
    `)
    const insert = db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?)')
    for (const [provider, nativeId] of [['antigravity',native], ['grok',grok]]) {
      insert.run('host', provider, JSON.stringify({ nativeThreadRef: { nativeId } }))
    }
    log = path.join(home, '.gemini/antigravity/brain', native, '.system_generated/logs/transcript_full.jsonl')
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.writeFileSync(log, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '原生正文' }))
    const grokDir = path.join(home, '.grok/sessions/project', grok)
    fs.mkdirSync(grokDir, { recursive: true })
    fs.writeFileSync(path.join(grokDir,'summary.json'), JSON.stringify({ info: { id: grok } }))
    const request = '<t3_code_instructions>mode</t3_code_instructions><user_request>Context handoff (full_thread_summary): 历史转述\nUser message:\n当前提问</user_request>'
    fs.writeFileSync(path.join(grokDir,'chat_history.jsonl'), JSON.stringify({ type: 'user', content: request }))
    expect(await runScan({ homeDir: home, all: true })).toMatchObject({ new: 3, errors: 0 })
  })
  afterEach(() => {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function matches(term: string, field = 'message', agents?: string[]) {
    const result = await runSessionQuery({ version: 2, scope: { agents }, where: {
      mentions: { terms: [term], fields: [field] },
    } }, { homeDir: home })
    return result.outcomes.filter(row => row.selectionStatus === 'matched').map(row => row.sessionId)
  }

  it('跨来源标题、正文和 provider 筛选均定位到同一线程', async () => {
    expect(await matches('宿主标题','title')).toEqual(['t3-host'])
    expect(await matches('原生正文','message',['antigravity'])).toEqual(['t3-host'])
    expect(await matches('当前提问','message',['grok'])).toEqual(['t3-host'])
    expect(await matches('历史转述')).toEqual([])
    expect(await matches('宿主代发')).toEqual([])
  })

  it('show 和内容读取实时回源，损坏原生记录返回 unknown', async () => {
    fs.writeFileSync(log, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: '修改后的答复' }))
    const refs = [{ agent: 't3' as const, id: 't3-host' }]
    const [source] = await readSessionSources(refs, { homeDir: home })
    expect(source.messages.some(m => m.content === '修改后的答复')).toBe(true)
    const shown: string[] = []
    await runSessionsShow(native, { homeDir: home, stream: true }, { writeOutput: chunk => { shown.push(chunk) } })
    expect(shown.join('')).toContain('修改后的答复')
    fs.appendFileSync(log, '\n{')
    const [failed] = await readSessionEventSources(refs, { homeDir: home })
    expect(failed.status).toBe('failed')
    const query = await runSessionQuery({version: 2}, {homeDir: home})
    expect(query.coverage).toMatchObject({ candidates: 1, unknown: 1 })
  })

  it('解除关联后恢复独立会话，匹配文本相同也不误合并', async () => {
    db.exec("DELETE FROM orchestration_v2_projection_provider_threads WHERE provider='antigravity'")
    db.exec(`INSERT INTO orchestration_v2_projection_messages VALUES ('host','2','user','2','{"createdBy":"user","text":"原生正文"}','2')`)
    await runScan({ homeDir: home, agents: ['t3'] })
    expect((await matches('原生正文')).sort()).toEqual([native,'t3-host'])
  })
})
