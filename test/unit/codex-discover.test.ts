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

  it('YYYY/MM/<file>.jsonl 3 层旧布局兼容（fixture 现状）', async () => {
    const tmp = makeTempDir()
    try {
      const uuid = '019d638b-1936-7f31-a505-a38278eebe9d'
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
      const flatUuid = '019d638b-1936-7f31-a505-a38278eebe9d'
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

  it('DD 目录下的非 UUID 文件 / 嵌套孙目录不被扫到', async () => {
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
      // 多余的孙级目录（HH 之类的将来扩展点 —— 当前 adapter 不应下钻）
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
      // 只该扫到 1 个（DD 下的 file），不下钻到 DD/HH/
      expect(sessions).toHaveLength(1)
      expect(sessions[0].id).toBe(uuid)
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
