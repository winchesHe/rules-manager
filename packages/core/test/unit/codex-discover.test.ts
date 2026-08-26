import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexAdapter } from '../../src/adapters/codex'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-codex-'))
}
function clean(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

function writeJsonl(filePath: string, sessionId: string, cwd: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const meta = {
    type: 'session_meta',
    timestamp: '2026-05-01T21:52:15.000Z',
    payload: {
      cwd,
      timestamp: '2026-05-01T21:52:15.000Z',
      git: { branch: 'main', commit_hash: 'abc123' },
    },
  }
  const userMsg = {
    type: 'response_item',
    timestamp: '2026-05-01T21:52:16.000Z',
    payload: { type: 'user_message' },
  }
  fs.writeFileSync(filePath, JSON.stringify(meta) + '\n' + JSON.stringify(userMsg) + '\n')
}

describe('codexAdapter.discover 跨目录布局', () => {
  it('YYYY/MM/DD/<file>.jsonl 4 层布局（本机 2026-05+ 真实结构）能扫到', async () => {
    const tmp = makeTempDir()
    try {
      const uuid = '019de3cf-bc35-7922-9eb7-3eee9610b8d3'
      writeJsonl(
        path.join(tmp, 'sessions', '2026', '05', '01', `rollout-2026-05-01T21-52-15-${uuid}.jsonl`),
        uuid,
        '/some/path/Real-Daylevel-Project',
      )

      const sessions = await codexAdapter.discover(tmp)
      expect(sessions).toHaveLength(1)
      expect(sessions[0].id).toBe(uuid)
      expect(sessions[0].agent).toBe('codex')
      expect(sessions[0].sourcePath).toMatch(/2026\/05\/01\/rollout-/)
    } finally {
      clean(tmp)
    }
  })

  it('updatedAt 使用文件最后修改时间而不是 session_meta 的会话开始时间', async () => {
    const tmp = makeTempDir()
    try {
      const uuid = '019de3cf-bc35-7922-9eb7-3eee9610b8d3'
      const filePath = path.join(
        tmp,
        'sessions',
        '2026',
        '05',
        '01',
        `rollout-${uuid}.jsonl`,
      )
      writeJsonl(filePath, uuid, '/some/path')
      const lastActivity = new Date('2026-07-29T12:34:56.000Z')
      fs.utimesSync(filePath, lastActivity, lastActivity)

      const [session] = await codexAdapter.discover(tmp)
      expect(session.updatedAt).toBe(lastActivity.toISOString())
    } finally {
      clean(tmp)
    }
  })

  it('YYYY/MM/<file>.jsonl 3 层旧布局兼容（fixture 现状）', async () => {
    const tmp = makeTempDir()
    try {
      const uuid = '55555555-5555-4555-8555-555555555555'
      writeJsonl(
        path.join(tmp, 'sessions', '2026', '04', `rollout-2026-04-07T00-05-53-${uuid}.jsonl`),
        uuid,
        '/some/path/Legacy-Flat-Project',
      )

      const sessions = await codexAdapter.discover(tmp)
      expect(sessions).toHaveLength(1)
      expect(sessions[0].id).toBe(uuid)
    } finally {
      clean(tmp)
    }
  })

  it('同月份混合 3 层文件 + 4 层日目录 → 全部扫到', async () => {
    const tmp = makeTempDir()
    try {
      const flatUuid = '55555555-5555-4555-8555-555555555555'
      const dayUuid = '019de3cf-bc35-7922-9eb7-3eee9610b8d3'
      writeJsonl(
        path.join(tmp, 'sessions', '2026', '05', `rollout-flat-${flatUuid}.jsonl`),
        flatUuid,
        '/some/path/flat',
      )
      writeJsonl(
        path.join(tmp, 'sessions', '2026', '05', '01', `rollout-day-${dayUuid}.jsonl`),
        dayUuid,
        '/some/path/day',
      )

      const sessions = await codexAdapter.discover(tmp)
      expect(sessions).toHaveLength(2)
      expect(sessions.map((s) => s.id).sort()).toEqual([flatUuid, dayUuid].sort())
    } finally {
      clean(tmp)
    }
  })

  it('DD 目录下的非 UUID 文件不被扫到，未来新增层级仍递归发现 rollout', async () => {
    const tmp = makeTempDir()
    try {
      const uuid = '019de3cf-bc35-7922-9eb7-3eee9610b8d3'
      writeJsonl(
        path.join(tmp, 'sessions', '2026', '05', '01', `rollout-${uuid}.jsonl`),
        uuid,
        '/x',
      )
      // 无 UUID 后缀的文件
      fs.writeFileSync(path.join(tmp, 'sessions', '2026', '05', '01', 'README.txt'), 'noise')
      // 新增的孙级目录（HH 等未来布局）也应继续下钻。
      fs.mkdirSync(path.join(tmp, 'sessions', '2026', '05', '01', '12'), { recursive: true })
      writeJsonl(
        path.join(
          tmp,
          'sessions',
          '2026',
          '05',
          '01',
          '12',
          `rollout-deep-019de3cf-bc35-7922-9eb7-3eee9610b8d4.jsonl`,
        ),
        '019de3cf-bc35-7922-9eb7-3eee9610b8d4',
        '/y',
      )

      const sessions = await codexAdapter.discover(tmp)
      expect(sessions).toHaveLength(2)
      expect(sessions.map((session) => session.id).sort()).toEqual(
        [uuid, '019de3cf-bc35-7922-9eb7-3eee9610b8d4'].sort(),
      )
    } finally {
      clean(tmp)
    }
  })

  it('parse 与 extractProjectHints 在 4 层布局发现的 session 上正常工作', async () => {
    const tmp = makeTempDir()
    try {
      const uuid = '019de3cf-bc35-7922-9eb7-3eee9610b8d3'
      writeJsonl(
        path.join(tmp, 'sessions', '2026', '05', '01', `rollout-${uuid}.jsonl`),
        uuid,
        '/Users/me/Projects/Daylevel-Sample',
      )

      const [session] = await codexAdapter.discover(tmp)
      const parsed = await codexAdapter.parse(session)
      expect(parsed.metadata.cwd).toBe('/Users/me/Projects/Daylevel-Sample')
      expect(parsed.metadata.branch).toBe('main')

      const hints = await codexAdapter.extractProjectHints(session)
      expect(hints).toHaveLength(1)
      expect(hints[0].kind).toBe('cwd')
      expect(hints[0].value).toBe('/Users/me/Projects/Daylevel-Sample')
    } finally {
      clean(tmp)
    }
  })
})
