import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from '@jest/globals'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const componentRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../renderer/src/components',
)

type Component = (props: Record<string, unknown>) => ReturnType<typeof createElement>

function loadComponent(fileName: string, exportName: string): Component {
  const source = fs.readFileSync(path.join(componentRoot, fileName), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
  }).outputText
  const loaded = { exports: {} as Record<string, Component> }
  const evaluate = new Function('require', 'module', 'exports', output)
  evaluate(require, loaded, loaded.exports)
  return loaded.exports[exportName]
}

const MetricStrip = loadComponent('MetricStrip.tsx', 'MetricStrip')
const PageHeader = loadComponent('PageHeader.tsx', 'PageHeader')
const PageSection = loadComponent('PageSection.tsx', 'PageSection')
const PageShell = loadComponent('PageShell.tsx', 'PageShell')
const SupportingPaneLayout = loadComponent(
  'SupportingPaneLayout.tsx',
  'SupportingPaneLayout',
)

describe('page layout primitives', () => {
  it('PageShell renders archetype, width, density and scroll ownership', () => {
    const html = renderToStaticMarkup(
      createElement(
        PageShell,
        {
          archetype: 'dashboard',
          density: 'compact',
          padding: 'page',
          scroll: 'page',
          width: 'wide',
        },
        'content',
      ),
    )

    expect(html).toContain('data-page-shell="true"')
    expect(html).toContain('data-layout="dashboard"')
    expect(html).toContain('data-width="wide"')
    expect(html).toContain('data-density="compact"')
    expect(html).toContain('data-padding="page"')
    expect(html).toContain('data-scroll-owner="page"')
    expect(html).toContain('max-w-[81rem]')
    expect(html).toContain('px-[clamp(0.5rem,1vw,1rem)]')
  })

  it('SupportingPaneLayout preserves main-before-pane order and semantic width', () => {
    const html = renderToStaticMarkup(
      createElement(
        SupportingPaneLayout,
        {
          collapseAt: 'lg',
          pane: createElement('p', null, 'supporting'),
          paneLabel: 'Context',
          paneWidth: 'md',
        },
        createElement('p', null, 'primary'),
      ),
    )

    expect(html).toContain('data-pane-layout="true"')
    expect(html).toContain('data-pane-width="md"')
    expect(html).toContain('data-collapse-at="lg"')
    expect(html).toContain('--supporting-pane-width:20rem')
    expect(html.indexOf('data-layout-region="main"'))
      .toBeLessThan(html.indexOf('data-layout-region="pane"'))
    expect(html).toContain('@min-[64rem]')
  })

  it('MetricStrip renders real metrics and rejects a fifth item', () => {
    const items = [
      { label: 'A', value: '1' },
      { label: 'B', note: 'ready', value: '2' },
    ]
    const html = renderToStaticMarkup(
      createElement(MetricStrip, { ariaLabel: 'Metrics', items }),
    )

    expect(html).toContain('data-metric-strip="true"')
    expect(html).toContain('data-metric-count="2"')
    expect(html).toContain('ready')
    expect(() =>
      renderToStaticMarkup(
        createElement(MetricStrip, {
          ariaLabel: 'Too many',
          items: Array.from({ length: 5 }, (_, index) => ({
            label: String(index),
            value: String(index),
          })),
        }),
      ),
    ).toThrow('at most four')
  })

  it('PageHeader and PageSection expose stable semantic regions', () => {
    const html = renderToStaticMarkup(
      createElement(
        PageShell,
        { archetype: 'task' },
        createElement(PageHeader, {
          actions: createElement('button', null, 'Run'),
          description: 'Description',
          title: 'Title',
        }),
        createElement(
          PageSection,
          {
            action: createElement('button', null, 'Manage'),
            description: 'Section description',
            title: 'Section title',
          },
          'Section content',
        ),
      ),
    )

    expect(html).toContain('data-page-header="true"')
    expect(html).toContain('<h1')
    expect(html).toContain('data-page-section="true"')
    expect(html).toContain('<h2')
  })
})
