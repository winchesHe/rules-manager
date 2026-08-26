import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@jest/globals'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = path.join(appRoot, 'renderer/src')

describe('Agent Dashboard UX transitions', () => {
  it('页面区块使用 TokenTracker 同款分层进入动画', () => {
    const transition = fs.readFileSync(
      path.join(rendererRoot, 'components/UxTransition.tsx'),
      'utf8',
    )
    const styles = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8')

    expect(transition).toContain('export function EntranceTransition')
    expect(transition).toContain('delay?: 0 | 50 | 110')
    expect(transition).toContain("'--ux-enter-delay': `${delay}ms`")
    expect(transition).toContain('className="ux-filter-transition"')
    expect(transition).toContain('aria-busy={busy}')
    expect(styles).toContain('animation: ux-content-enter 350ms cubic-bezier(0.16, 1, 0.3, 1)')
    expect(styles).toContain('transform: translateY(12px)')
    expect(styles).toContain('.ux-stagger-regions > *')
    expect(styles).toContain(".ux-page-transition[data-transition-key^='rules:'] > :not([data-page-shell])")
    expect(styles).toContain('.ux-enter-delay-160')
    expect(styles).not.toContain('animation: ux-page-enter 180ms')
    expect(styles).not.toContain('animation: ux-filter-enter 140ms')
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/)
    expect(styles).toContain(".ux-filter-transition[data-busy='true']")
    expect(transition).toContain('data-transition-key={transitionKey}')
  })

  it('规则、设置与 Chat 的主要模块也使用错峰入场', () => {
    const pageShell = fs.readFileSync(path.join(rendererRoot, 'components/PageShell.tsx'), 'utf8')
    const settings = fs.readFileSync(path.join(rendererRoot, 'views/SettingsView.tsx'), 'utf8')
    const chat = fs.readFileSync(path.join(rendererRoot, 'views/ChatView.tsx'), 'utf8')

    expect(pageShell).toContain('ux-stagger-regions')
    expect(settings.match(/className="ux-stagger-regions"/g)).toHaveLength(3)
    expect(chat).toContain('ux-entrance-fade ux-enter-delay-50')
    expect(chat).toContain('ux-entrance-transition ux-enter-delay-110')
    expect(chat).toContain('ux-entrance-transition ux-enter-delay-160')
    expect(chat).toContain('ux-entrance-fade ux-enter-delay-160')
  })

  it('App 页面切换和 Scan 筛选使用统一过渡', () => {
    const app = fs.readFileSync(path.join(rendererRoot, 'App.tsx'), 'utf8')
    const overview = fs.readFileSync(path.join(rendererRoot, 'views/OverviewView.tsx'), 'utf8')

    expect(app).toContain('<PageTransition')
    expect(app).toContain("activeView === 'rules' ? activeRulesSection : 'root'")
    expect(overview).toContain('transitionKey="scan:history"')
    expect(overview).toContain('transitionKey="scan:create"')
    expect(overview).toContain('transitionKey={`scan-changes:${filter}`}')
    expect(overview).toContain('<EntranceTransition delay={50}>')
    expect(overview).toContain('<EntranceTransition delay={110}>')
  })

  it('项目搜索延迟计算并提供结果数量和忙碌反馈', () => {
    const projects = fs.readFileSync(path.join(rendererRoot, 'views/ProjectsView.tsx'), 'utf8')

    expect(projects).toContain('const deferredQuery = useDeferredValue(query)')
    expect(projects).toContain('filterProjectRows(rows, deferredQuery, filter)')
    expect(projects).toContain('busy={isFiltering}')
    expect(projects).toContain('<EntranceTransition>')
    expect(projects).toContain('<EntranceTransition delay={110}>')
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
