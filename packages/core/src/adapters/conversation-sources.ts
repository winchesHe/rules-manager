import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { antigravitySummaries } from '../antigravity-source.js'
import { readAntigravityEvents } from '../session-events.js'
import type { AgentAdapter, DiscoveredSession } from '../types.js'
import { listT3Threads, listT3Bindings, readT3Thread, t3ContentWatermarks, t3Projects } from '../t3-source.js'
import { defaultNormalize, isUuid } from './shared.js'

const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

function dirs(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
}

function adapter(name: 't3' | 'antigravity', discover: (root: string) => DiscoveredSession[]): AgentAdapter {
  return {
    name, async discover(root) { return discover(root) },
    async probe(root) { return { matched: discover(root).length > 0 } },
    async extractProjectHints(s) {
      return s.cwd && path.isAbsolute(s.cwd)
        ? [{ kind: 'cwd', value: s.cwd, confidence: 0.9, agent: name, source: 'metadata', locator: 'workspace' }]
        : []
    },
    async parse(s) {
      const parsed = { agent: name, sessionId: s.id, sourcePath: s.sourcePath,
        metadata: { cwd: s.cwd }, lastTimestamp: s.updatedAt }
      if (name === 't3') {
        const snapshot = readT3Thread(s.sourcePath, decodeURIComponent(s.id.slice(3)))
        if (!snapshot) throw new Error('T3 线程已删除：' + s.id)
        return { ...parsed, messageCount: snapshot.messages.length, toolCallCount: snapshot.tools.length }
      }
      const { events } = readAntigravityEvents(s.sourcePath, s.id)
      return { ...parsed, messageCount: events.filter(e => e.kind === 'message').length,
        toolCallCount: events.filter(e => e.kind === 'tool_call').length }
    },
    normalize: defaultNormalize,
  }
}

export const t3Adapter = adapter('t3', root => {
  const file = path.join(root, 'userdata', 'statev2.sqlite')
  if (!fs.existsSync(file)) return []
  const projects = t3Projects(file)
  const watermarks = t3ContentWatermarks(file)
  const bindings = new Map<string, ReturnType<typeof listT3Bindings>>()
  for (const binding of listT3Bindings(file)) {
    const group = bindings.get(binding.threadId) ?? []
    group.push(binding)
    bindings.set(binding.threadId, group)
  }
  return listT3Threads(file).map(t => ({
    id: 't3-' + encodeURIComponent(t.id), agent: 't3', sourcePath: file, sourceKind: 'sqlite',
    cwd: projects.get(t.projectId), updatedAt: t.updatedAt, nativeBindings: bindings.get(t.id) ?? [],
    contentHash: hash([t, bindings.get(t.id), watermarks.get(t.id)]),
  }))
})

export const antigravityAdapter = adapter('antigravity', root => {
  const providers = path.join(root, '.t3/userdata/providers/antigravity')
  const roots = [root, path.join(root, '.gemini/antigravity'), path.join(root, '.gemini/antigravity-cli'),
    ...dirs(providers).map(dir => path.join(providers, dir, 'antigravity-acp'))]
  const sessions = new Map<string, DiscoveredSession>()
  for (const source of roots) {
    const metadata = antigravitySummaries(source)
    const brain = path.join(source, 'brain')
    const conversations = path.join(source, 'conversations')
    const databases = fs.existsSync(conversations) ? fs.readdirSync(conversations)
      .filter(f => f.endsWith('.db')).map(f => f.slice(0, -3)) : []
    for (const id of new Set([...databases, ...dirs(brain)].filter(isUuid))) {
      const full = path.join(brain, id, '.system_generated/logs/transcript_full.jsonl')
      const file = fs.existsSync(full) ? full : path.join(conversations, id + '.db')
      if (!fs.existsSync(file)) continue
      const stat = fs.statSync(file)
      const row = metadata.get(id)
      const uri = row && (JSON.parse(row.uris || '[]') as string[]).find(u => u.startsWith('file:'))
      const entry = { id, agent: 'antigravity' as const, sourcePath: file, sourceKind: path.extname(file),
        updatedAt: stat.mtime.toISOString(), cwd: uri ? fileURLToPath(uri) : undefined,
        contentHash: hash([stat.size, stat.mtimeMs, row]) }
      const prior = sessions.get(id)
      if (!prior || (prior.sourceKind !== entry.sourceKind ? file === full : prior.updatedAt < entry.updatedAt)) {
        sessions.set(id, entry)
      }
    }
  }
  return [...sessions.values()]
})
