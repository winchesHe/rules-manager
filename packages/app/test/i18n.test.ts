import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@jest/globals'
import ts from 'typescript'
import {
  defaultLocale,
  readStoredLocale,
  supportedLocales,
  tryWriteStoredLocale,
  writeStoredLocale,
} from '../renderer/src/i18n/locale.js'
import {
  formatDate,
  formatDateTime,
  formatNumber,
} from '../renderer/src/i18n/format.js'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = path.join(appRoot, 'renderer/src')
const localeRoot = path.join(rendererRoot, 'i18n/locales')

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : []
  }
  return Object.entries(value)
    .flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key))
    .sort()
}

describe('APP i18n', () => {
  it('只支持简体中文和英文，并默认简体中文', () => {
    expect(supportedLocales).toEqual(['zh-CN', 'en-US'])
    expect(defaultLocale).toBe('zh-CN')
  })

  it('读取和保存合法偏好，非法或损坏偏好回退中文', () => {
    const storage = new MemoryStorage()
    expect(readStoredLocale(storage)).toBe('zh-CN')

    storage.setItem('memory-manager.locale', 'en-US')
    expect(readStoredLocale(storage)).toBe('en-US')

    storage.setItem('memory-manager.locale', 'fr-FR')
    expect(readStoredLocale(storage)).toBe('zh-CN')

    writeStoredLocale(storage, 'zh-CN')
    expect(storage.getItem('memory-manager.locale')).toBe('zh-CN')

    expect(
      tryWriteStoredLocale(
        {
          setItem: () => {
            throw new Error('quota exceeded')
          },
        },
        'en-US',
      ),
    ).toBe(false)
  })

  it('显式按当前 locale 格式化日期和数字', () => {
    const value = new Date('2026-07-30T08:15:00.000Z')
    expect(formatDate(value, 'zh-CN', 'UTC')).toBe('2026年7月30日')
    expect(formatDate(value, 'en-US', 'UTC')).toBe('Jul 30, 2026')
    expect(formatDateTime(value, 'zh-CN', 'UTC')).toContain('2026')
    expect(formatDateTime(value, 'en-US', 'UTC')).toContain('2026')
    expect(formatNumber(12345.6, 'zh-CN')).toBe(
      new Intl.NumberFormat('zh-CN').format(12345.6),
    )
    expect(formatNumber(12345.6, 'en-US')).toBe(
      new Intl.NumberFormat('en-US').format(12345.6),
    )
  })

  it('两种语言的 namespace 和资源 key 完全一致且值非空', () => {
    const locales = supportedLocales.map((locale) => {
      const directory = path.join(localeRoot, locale)
      const files = fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort()
      const resources = Object.fromEntries(
        files.map((file) => [
          file,
          JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as unknown,
        ]),
      )
      return { locale, files, resources }
    })

    expect(locales[0]?.files).toEqual([
      'common.json',
      'navigation.json',
      'projects.json',
      'rules.json',
      'scan.json',
      'settings.json',
    ])
    expect(locales[1]?.files).toEqual(locales[0]?.files)

    for (const file of locales[0]?.files ?? []) {
      const chinese = locales[0]?.resources[file]
      const english = locales[1]?.resources[file]
      expect(flattenKeys(english)).toEqual(flattenKeys(chinese))
      for (const resource of [chinese, english]) {
        for (const key of flattenKeys(resource)) {
          const value = key
            .split('.')
            .reduce<unknown>(
              (current, segment) =>
                current && typeof current === 'object'
                  ? (current as Record<string, unknown>)[segment]
                  : undefined,
              resource,
            )
          expect(typeof value).toBe('string')
          expect((value as string).trim()).not.toBe('')
        }
      }
    }
  })

  it('启动入口在 React 挂载前初始化语言，Settings 提供语言切换', () => {
    const main = fs.readFileSync(path.join(rendererRoot, 'main.tsx'), 'utf8')
    const settings = fs.readFileSync(
      path.join(rendererRoot, 'views/SettingsView.tsx'),
      'utf8',
    )
    expect(main).toContain('initializeI18n')
    expect(main.indexOf('initializeI18n()')).toBeLessThan(main.indexOf('createRoot('))
    expect(settings).toContain("id: 'general'")
    expect(settings).toContain('changeAppLocale')
    expect(settings).toContain('简体中文')
    expect(settings).toContain('English')
  })

  it('Renderer 不再依赖隐式系统 locale，也没有未登记的 JSX 硬编码文案', () => {
    const sourceFiles = fs
      .readdirSync(path.join(rendererRoot, 'views'))
      .filter((file) => file.endsWith('.tsx'))
      .map((file) => path.join(rendererRoot, 'views', file))
      .concat(
        fs
          .readdirSync(path.join(rendererRoot, 'components'))
          .filter((file) => file.endsWith('.tsx'))
          .map((file) => path.join(rendererRoot, 'components', file)),
        path.join(rendererRoot, 'App.tsx'),
      )
    const allowedText = new Set([
      'A',
      'M',
      'Memory Manager',
      'Claude · Codex',
      'English',
      '简体中文',
    ])
    const userFacingAttributes = new Set([
      'aria-label',
      'description',
      'eyebrow',
      'label',
      'placeholder',
      'title',
    ])
    const violations: string[] = []

    const isInsideDisabledBranch = (node: ts.Node): boolean => {
      let current: ts.Node | undefined = node.parent
      while (current) {
        if (
          ts.isBinaryExpression(current) &&
          current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          current.left.kind === ts.SyntaxKind.FalseKeyword
        ) {
          return true
        }
        current = current.parent
      }
      return false
    }

    for (const file of sourceFiles) {
      const source = fs.readFileSync(file, 'utf8')
      expect(source).not.toMatch(
        /toLocale(?:String|DateString|TimeString)\(|Intl\.(?:DateTimeFormat|NumberFormat)\(undefined/,
      )
      const parsed = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      )
      const visit = (node: ts.Node): void => {
        if (isInsideDisabledBranch(node)) return
        if (ts.isJsxText(node)) {
          const text = node.text.replace(/\s+/g, ' ').trim()
          if (
            text &&
            /[A-Za-z\u3400-\u9fff]/.test(text) &&
            !allowedText.has(text)
          ) {
            violations.push(`${path.relative(rendererRoot, file)}: ${text}`)
          }
        }
        if (
          ts.isJsxAttribute(node) &&
          userFacingAttributes.has(node.name.getText(parsed)) &&
          node.initializer &&
          ts.isStringLiteral(node.initializer)
        ) {
          violations.push(
            `${path.relative(rendererRoot, file)}: ${node.name.getText(parsed)}="${node.initializer.text}"`,
          )
        }
        ts.forEachChild(node, visit)
      }
      visit(parsed)
    }

    expect(violations).toEqual([])
  })

  it('Rules 使用的静态语义 key 都存在于资源文件', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'views/RulesView.tsx'), 'utf8')
    const resources = JSON.parse(
      fs.readFileSync(path.join(localeRoot, 'zh-CN/rules.json'), 'utf8'),
    ) as unknown
    const keys = new Set(flattenKeys(resources))
    const usedKeys = [...source.matchAll(/\btr\('([^']+)'/g)].map((match) => match[1]!)
    const missing = usedKeys.filter(
      (key) => !keys.has(key) && !keys.has(`${key}_one`) && !keys.has(`${key}_other`),
    )

    expect(usedKeys.length).toBeGreaterThan(100)
    expect(missing).toEqual([])
    expect(usedKeys.some((key) => key.includes(':'))).toBe(false)
  })
})
