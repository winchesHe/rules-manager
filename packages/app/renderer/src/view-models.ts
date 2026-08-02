import type { ScanSummary } from './types.js'

export interface ProjectScanChange {
  slug: string
  agents: string[]
  newCount: number
  updatedCount: number
  missingCount: number
}

export interface FilterableProjectRow {
  slug: string
  changedCount: number
  draftCount: number
  isUnclassified: boolean
}

export type ProjectFilter = 'all' | 'changed' | 'draft' | 'unclassified'

export function groupScanChanges(summary: ScanSummary): ProjectScanChange[] {
  const grouped = new Map<
    string,
    { agents: Set<string>; newCount: number; updatedCount: number; missingCount: number }
  >()

  function add(
    change: ScanSummary['changes']['new'][number],
    kind: 'newCount' | 'updatedCount' | 'missingCount',
  ): void {
    const row = grouped.get(change.slug) ?? {
      agents: new Set<string>(),
      newCount: 0,
      updatedCount: 0,
      missingCount: 0,
    }
    row.agents.add(change.agent)
    row[kind] += 1
    grouped.set(change.slug, row)
  }

  summary.changes.new.forEach((change) => add(change, 'newCount'))
  summary.changes.updated.forEach((change) => add(change, 'updatedCount'))
  summary.changes.missing.forEach((change) => add(change, 'missingCount'))

  return [...grouped.entries()]
    .map(([slug, row]) => ({
      slug,
      agents: [...row.agents].sort(),
      newCount: row.newCount,
      updatedCount: row.updatedCount,
      missingCount: row.missingCount,
    }))
    .sort((left, right) => {
      const leftTotal = left.newCount + left.updatedCount + left.missingCount
      const rightTotal = right.newCount + right.updatedCount + right.missingCount
      return rightTotal - leftTotal || left.slug.localeCompare(right.slug)
    })
}

export function filterProjectRows<T extends FilterableProjectRow>(
  rows: T[],
  query: string,
  filter: ProjectFilter,
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return rows.filter((row) => {
    if (normalizedQuery && !row.slug.toLocaleLowerCase().includes(normalizedQuery)) return false
    if (filter === 'changed') return row.changedCount > 0
    if (filter === 'draft') return row.draftCount > 0
    if (filter === 'unclassified') return row.isUnclassified
    return true
  })
}

export interface FilterableProjectSession {
  id: string
  displayName: string
  sourcePath: string
  agent: string
  status: string
}

export function filterProjectSessions<T extends FilterableProjectSession>(
  sessions: T[],
  query: string,
  agent: string,
  status: string,
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return sessions.filter((session) => {
    const matchesQuery = !normalizedQuery
      || session.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || session.id.toLocaleLowerCase().includes(normalizedQuery)
      || session.sourcePath.toLocaleLowerCase().includes(normalizedQuery)
    const matchesAgent = agent === 'all' || session.agent === agent
    const matchesStatus = status === 'all' || session.status === status
    return matchesQuery && matchesAgent && matchesStatus
  })
}

export interface VirtualWindowOptions {
  itemCount: number
  scrollTop: number
  rowHeight: number
  viewportHeight: number
  overscan: number
}

export interface VirtualWindow {
  start: number
  end: number
  offsetTop: number
  totalHeight: number
}

export function calculateVirtualWindow({
  itemCount,
  scrollTop,
  rowHeight,
  viewportHeight,
  overscan,
}: VirtualWindowOptions): VirtualWindow {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(
    itemCount,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
  )
  return {
    start,
    end,
    offsetTop: start * rowHeight,
    totalHeight: itemCount * rowHeight,
  }
}
