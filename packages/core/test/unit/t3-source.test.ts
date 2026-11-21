import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { listT3Threads, readT3Thread } from '../../src/t3-source'

describe('T3 线程读取', () => {
  let dir: string
  let file: string
  let db: Database.Database

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-reader-'))
    file = path.join(dir, 'statev2.sqlite')
    db = new Database(file)
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, created_at, updated_at, deleted_at);
      CREATE TABLE orchestration_v2_projection_provider_threads (thread_id, provider, payload_json);
      CREATE TABLE orchestration_v2_projection_messages (thread_id, message_id, role, created_at, payload_json);
      INSERT INTO orchestration_v2_projection_threads VALUES
        ('a','project','讨论','grok','1','2',NULL), ('b','project','旧线程','pi','1','2','3');
      INSERT INTO orchestration_v2_projection_provider_threads VALUES
        ('a','grok','{"nativeThreadRef":{"nativeId":"first"}}'),
        ('a','grok','{"nativeThreadRef":{"nativeId":"second"}}');
      INSERT INTO orchestration_v2_projection_messages VALUES
        ('a','later','user','2','{"createdBy":"agent","text":"宿主代发"}'),
        ('a','first','user','1','{"createdBy":"user","text":"真人输入"}');
    `)
  })
  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('多个原生 ID 对应一个线程，并按时间读取不同来源的消息', () => {
    expect(listT3Threads(file).map(t => t.id)).toEqual(['a'])
    const result = readT3Thread(file, 'a')!
    expect(result.bindings.map(b => b.nativeId)).toEqual(['first', 'second'])
    expect(result.messages.map(m => [m.id, m.createdBy])).toEqual([['first','user'], ['later','agent']])
  })

  it('已删除线程和未知 ID 不参与回读', () => {
    expect(readT3Thread(file, 'b')).toBeUndefined()
    expect(readT3Thread(file, 'missing')).toBeUndefined()
  })

  it('消息损坏时报告读取失败', () => {
    db.exec("UPDATE orchestration_v2_projection_messages SET payload_json = 'invalid'")
    expect(() => readT3Thread(file, 'a')).toThrow(/malformed JSON/)
  })
})
