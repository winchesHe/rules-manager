import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@jest/globals'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = path.join(appRoot, 'renderer/src')

describe('Agent Dashboard UX transitions', () => {
  it('页面和筛选结果使用统一的轻量过渡', () => {
    const transition = fs.readFileSync(
      path.join(rendererRoot, 'components/UxTransition.tsx'),
      'utf8',
    )
    const styles = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8')

    expect(transition).toContain('className={`ux-page-transition ${className}`.trim()}')
    expect(transition).toContain('className="ux-filter-transition"')
    expect(transition).toContain('aria-busy={busy}')
    expect(styles).toContain('animation: ux-page-enter 180ms')
    expect(styles).toContain('animation: ux-filter-enter 140ms')
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/)
    expect(styles).toContain(".ux-filter-transition[data-busy='true']")
  })

  it('App 页面切换和 Scan 筛选使用统一过渡', () => {
    const app = fs.readFileSync(path.join(rendererRoot, 'App.tsx'), 'utf8')
    const overview = fs.readFileSync(path.join(rendererRoot, 'views/OverviewView.tsx'), 'utf8')

    expect(app).toContain('<PageTransition')
    expect(app).toContain("activeView === 'rules' ? activeRulesSection : 'root'")
    expect(overview).toContain('transitionKey="scan:history"')
    expect(overview).toContain('transitionKey="scan:create"')
    expect(overview).toContain('transitionKey={`scan-changes:${filter}`}')
  })

  it('项目搜索延迟计算并提供结果数量和忙碌反馈', () => {
    const projects = fs.readFileSync(path.join(rendererRoot, 'views/ProjectsView.tsx'), 'utf8')

    expect(projects).toContain('const deferredQuery = useDeferredValue(query)')
    expect(projects).toContain('filterProjectRows(rows, deferredQuery, filter)')
    expect(projects).toContain('busy={isFiltering}')
    expect(projects).toContain("t('list.filteredCount'")
    expect(projects).toContain('const deferredSessionQuery = useDeferredValue(sessionQuery)')
    expect(projects).toContain('busy={isSessionFiltering}')
  })

  it('主导航切换不会显示居中的全屏加载转圈', () => {
    const overview = fs.readFileSync(path.join(rendererRoot, 'views/OverviewView.tsx'), 'utf8')
    const projects = fs.readFileSync(path.join(rendererRoot, 'views/ProjectsView.tsx'), 'utf8')

    expect(overview).not.toContain("if (loading) return <ViewLoading")
    expect(projects).not.toContain("if (loading) return <ViewLoading")
    expect(overview).not.toContain('TablePageSkeleton')
    expect(projects).not.toContain('TablePageSkeleton')
  })
})
