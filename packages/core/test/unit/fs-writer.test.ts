import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ensureDefaultSlugDir,
  linkSession,
  listLinks,
  moveLink,
  removeLink,
} from '../../src/fs-writer'

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mm-fsw-'))
}
function clean(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}
function makeJsonl(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, '{"hello":"world"}\n')
  return p
}

describe('fs-writer', () => {
  let home: string
  let workspaceDir: string
  let sourcesDir: string

  beforeEach(() => {
    home = makeTempHome()
    workspaceDir = path.join(home, '.memory-manager')
    fs.mkdirSync(workspaceDir, { recursive: true })
    sourcesDir = path.join(home, 'real-sources')
    fs.mkdirSync(sourcesDir, { recursive: true })
  })
  afterEach(() => clean(home))

  describe('linkSession', () => {
    it('建 <projects>/<slug>/<sid>.jsonl symlink，target 是 sourcePath', () => {
      const src = makeJsonl(sourcesDir, 'a.jsonl')
      const sid = 'abc-123'
      const linkPath = linkSession(workspaceDir, 'demo', sid, src)

      expect(linkPath).toBe(
        path.join(workspaceDir, 'projects', 'demo', `${sid}.jsonl`),
      )
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
      expect(fs.readlinkSync(linkPath)).toBe(src)
      // 真实读取应可获得内容
      expect(fs.readFileSync(linkPath, 'utf8')).toContain('hello')
    })

    it('幂等：同 sid 重复 link 覆盖 target，不抛', () => {
      const src1 = makeJsonl(sourcesDir, 'a.jsonl')
      const src2 = makeJsonl(sourcesDir, 'b.jsonl')
      const sid = 'sid-1'
      linkSession(workspaceDir, 'demo', sid, src1)
      const linkPath = linkSession(workspaceDir, 'demo', sid, src2)
      expect(fs.readlinkSync(linkPath)).toBe(src2)
    })

    it('source 不存在 → 抛错', () => {
      expect(() =>
        linkSession(workspaceDir, 'demo', 'x', path.join(sourcesDir, 'no-such.jsonl')),
      ).toThrow(/source not found/)
    })
  })

  describe('moveLink', () => {
    it('mv 单 link，from 目录变空且非 default → rmdir', () => {
      const src = makeJsonl(sourcesDir, 'a.jsonl')
      linkSession(workspaceDir, 'from-slug', 'sid', src)
      const dest = moveLink(workspaceDir, 'sid', 'from-slug', 'to-slug')

      expect(fs.existsSync(dest)).toBe(true)
      expect(fs.existsSync(path.join(workspaceDir, 'projects', 'from-slug'))).toBe(false)
    })

    it('fromSlug == toSlug → no-op，返回原 link 路径', () => {
      const src = makeJsonl(sourcesDir, 'a.jsonl')
      linkSession(workspaceDir, 'same', 'sid', src)
      const r = moveLink(workspaceDir, 'sid', 'same', 'same')
      expect(fs.existsSync(r)).toBe(true)
    })

    it('目标 slug 已有同 sid link → 覆盖', () => {
      const src1 = makeJsonl(sourcesDir, 'a.jsonl')
      const src2 = makeJsonl(sourcesDir, 'b.jsonl')
      linkSession(workspaceDir, 'from', 'sid', src1)
      linkSession(workspaceDir, 'to', 'sid', src2)

      const dest = moveLink(workspaceDir, 'sid', 'from', 'to')
      // 移动后 to/<sid>.jsonl 指向 src1（from 的 target）
      expect(fs.readlinkSync(dest)).toBe(src1)
    })
  })

  describe('removeLink', () => {
    it('删 link，目录变空且非 default → rmdir', () => {
      const src = makeJsonl(sourcesDir, 'a.jsonl')
      linkSession(workspaceDir, 'pruned', 'sid', src)
      removeLink(workspaceDir, 'pruned', 'sid')

      expect(fs.existsSync(path.join(workspaceDir, 'projects', 'pruned'))).toBe(false)
    })

    it('default/ 目录变空不被删', () => {
      const src = makeJsonl(sourcesDir, 'a.jsonl')
      linkSession(workspaceDir, 'default', 'sid', src)
      removeLink(workspaceDir, 'default', 'sid')

      expect(fs.existsSync(path.join(workspaceDir, 'projects', 'default'))).toBe(true)
    })

    it('link 不存在 → 不抛', () => {
      expect(() => removeLink(workspaceDir, 'noop', 'x')).not.toThrow()
    })
  })

  describe('listLinks', () => {
    it('返回 slug → sessionId[] 映射', () => {
      const src = makeJsonl(sourcesDir, 'a.jsonl')
      linkSession(workspaceDir, 'p1', 'sid-1', src)
      linkSession(workspaceDir, 'p1', 'sid-2', src)
      linkSession(workspaceDir, 'p2', 'sid-3', src)

      const m = listLinks(workspaceDir)
      expect(m.get('p1')?.sort()).toEqual(['sid-1', 'sid-2'])
      expect(m.get('p2')).toEqual(['sid-3'])
    })

    it('忽略非 .jsonl 文件（如 rules.md）', () => {
      const src = makeJsonl(sourcesDir, 'a.jsonl')
      linkSession(workspaceDir, 'p1', 'sid-1', src)
      fs.writeFileSync(path.join(workspaceDir, 'projects', 'p1', 'rules.md'), '# rules')

      const m = listLinks(workspaceDir)
      expect(m.get('p1')).toEqual(['sid-1'])
    })

    it('projectsDir 不存在 → 空 Map', () => {
      const m = listLinks(workspaceDir)
      expect(m.size).toBe(0)
    })
  })

  describe('ensureDefaultSlugDir', () => {
    it('幂等创建 projects/default/', () => {
      const dir = ensureDefaultSlugDir(home)
      expect(fs.existsSync(dir)).toBe(true)
      // 再调用一次不抛
      expect(() => ensureDefaultSlugDir(home)).not.toThrow()
    })
  })
})
