import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@jest/globals'

const rendererRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../renderer/src',
)
const appRoot = path.resolve(rendererRoot, '../..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(rendererRoot, relativePath), 'utf8')
}

describe('home workflow layout', () => {
  it('主导航使用 Scan / Projects / Chat / Rules', () => {
    const source = read('App.tsx')
    expect(source).toContain("labelKey: 'scan'")
    expect(source).toContain("labelKey: 'projects'")
    expect(source).toContain("labelKey: 'chat'")
    expect(source).toContain("labelKey: 'rules'")
    expect(source.indexOf("labelKey: 'chat'"))
      .toBeLessThan(source.indexOf("labelKey: 'rules'"))
    expect(source).toContain('<ChatView')
    expect(source).toContain("useTranslation('navigation')")
    expect(source).toContain('overflow-x-hidden')
  })

  it('Chat 使用历史 Drawer、Conversation、Context，并提供首次发送才落盘的 Composer', () => {
    const source = read('views/ChatView.tsx')
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')

    expect(source).toContain("'chat.list'")
    expect(source).toContain("'chat.read'")
    expect(source).toContain("t('threadRail')")
    expect(source).toContain("t('conversation')")
    expect(source).toContain("t('context')")
    expect(source).toContain('projectResponses')
    expect(source).toContain("t('openGeneratedRules')")
    expect(source).toContain('data-chat-composer')
    expect(source).toContain("'chat.send'")
    expect(source).toContain("'chat.event'")
    expect(source).toContain("'chat.skills'")
    expect(source).toContain("'chat.tool.read'")
    expect(source).toContain("'chat.context.query'")
    expect(source).toContain("'chat.context.update'")
    expect(source).toContain("'chat.context.resolve'")
    expect(source).toContain('SessionContextPicker')
    expect(source).toContain('recent7Days')
    expect(source).toContain('recent30Days')
    expect(source).toContain('translateY(${start * rowHeight}px)')
    expect(source).toContain('queueRef.current')
    expect(source).toContain('isDisabled={thread?.kind === \'native-chat\'}')
    expect(source).toContain('ToolActivityList')
    expect(source).toContain('liveUsage')
    expect(source).toContain("t('newChat'")
    expect(ipcSource).toContain("ipcMain.handle('chat.list'")
    expect(ipcSource).toContain("ipcMain.handle('chat.read'")
    expect(ipcSource).toContain("ipcMain.handle('chat.send'")
    expect(ipcSource).toContain("ipcMain.handle('chat.interrupt'")
    expect(ipcSource).toContain("ipcMain.handle('chat.skills'")
    expect(ipcSource).toContain("ipcMain.handle('chat.tool.read'")
    expect(ipcSource).toContain("ipcMain.handle('chat.context.query'")
    expect(ipcSource).toContain("ipcMain.handle('chat.context.update'")
    expect(ipcSource).toContain("ipcMain.handle('chat.rename'")
    expect(ipcSource).toContain("ipcMain.handle('chat.pin'")
    expect(ipcSource).toContain("ipcMain.handle('chat.unpin'")
    expect(ipcSource).toContain("ipcMain.handle('chat.archive'")
    expect(ipcSource).toContain("ipcMain.handle('chat.unarchive'")
    expect(ipcSource).toContain("ipcMain.handle('chat.delete'")
    expect(source).toContain("'chat.rename'")
    expect(source).toContain("'chat.pin'")
    expect(source).toContain("'chat.unpin'")
    expect(source).toContain("'chat.archive'")
    expect(source).toContain("'chat.unarchive'")
    expect(source).toContain("'chat.delete'")
    expect(source).toContain('deleteConfirmThread')
    expect(source).toContain('historyPaneOpen')
    expect(source).toContain('contextPaneOpen')
    expect(source).toContain('thread.sessionContext.revision')
    expect(source).toContain('[thread?.id, sessionContextRevision]')
    expect(source).toContain('continueAsNewChat')
    expect(source).toContain('compactContextOpen')
    expect(source).toContain('max-[1279px]:fixed')
  })

  it('Chat 固定 viewport 高度并把滚动限制在三段内容区', () => {
    const appSource = read('App.tsx')
    const chatSource = read('views/ChatView.tsx')

    expect(appSource).toContain("activeView === 'chat'")
    expect(appSource).toContain("'overflow-y-hidden")
    expect(chatSource).toContain('h-screen')
    expect(chatSource).toContain('overflow-hidden')
    expect(chatSource.match(/overflow-y-auto/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('Chat 使用默认展开的历史栏、可收起 Context 和 820px 阅读线', () => {
    const source = read('views/ChatView.tsx')

    expect(source).toContain('data-chat-workspace')
    expect(source).toContain('grid-cols-[minmax(0,1fr)_22rem]')
    expect(source).toContain('grid-cols-[minmax(0,1fr)_0rem]')
    expect(source).toContain('grid-cols-[18rem_minmax(0,1fr)]')
    expect(source).toContain('grid-cols-[0rem_minmax(0,1fr)]')
    expect(source).toContain('useState(true)')
    expect(source).toContain('transition-[grid-template-columns]')
    expect(source).toContain('motion-reduce:transition-none')
    expect(source).toContain('max-[1279px]:grid-cols-1')
    expect(source).toContain("window.matchMedia('(max-width: 1279px)')")
    expect(source).toContain('inert={!contextPanelOpen}')
    expect(source).toContain("event.key !== 'Escape'")
    expect(source).toContain('composerOptionsOpen || (compactLayout && (historyPaneOpen || compactContextOpen))')
    expect(source).toContain('if (compactLayout) {')
    expect(source.match(/max-w-\[51\.25rem\]/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
    expect(source).toContain('data-chat-conversation')
    expect(source).toContain('data-chat-composer-surface')
    expect(source).toContain('data-chat-history-pane')
    expect(source).toContain('data-chat-header')
    expect(source).not.toContain('railCollapsed')
    expect(source).not.toContain('grid-cols-[16rem_minmax(0,1fr)_22rem]')
    expect(source).not.toContain('<Card className="h-full')
  })

  it('History 顶部严格遵循 HTML 原型的尺寸与层级', () => {
    const source = read('views/ChatView.tsx')

    expect(source).toContain('data-chat-history-head')
    expect(source).toContain('grid gap-2.5 border-b border-border-soft p-3')
    expect(source).toContain('text-[12px] font-[650] leading-[normal] text-pane-foreground')
    expect(source).toContain('inline-grid size-[30px] place-items-center rounded-lg')
    expect(source).toContain('h-[34px] w-full items-center justify-center gap-[7px] rounded-[9px]')
    expect(source).toContain('bg-pane-surface p-0 text-[11px] font-[620] leading-[normal]')
    expect(source).toContain('data-chat-history-tabs')
    expect(source).toContain('grid grid-cols-2 gap-1')
    expect(source).toContain('h-7 w-full min-w-0 rounded-[7px] border-0 text-[10px] font-normal leading-[normal]')
    expect(source).toContain('bg-surface-raised text-pane-foreground')
    expect(source).not.toContain('grid grid-cols-2 gap-1 rounded-lg bg-background/45 p-1')
  })

  it('Chat Header 分离历史入口与当前标题，Context 在右栏内关闭并从 Header 恢复', () => {
    const source = read('views/ChatView.tsx')

    expect(source).not.toContain('<h1 className="text-xl')
    expect(source).not.toContain('data-runtime-context')
    expect(source).not.toContain("<h2 className=\"text-sm font-semibold text-foreground\">{t('context')}</h2>")
    expect(source).toContain('data-chat-management-trigger')
    expect(source).toContain('data-chat-history-toggle')
    expect(source).toContain('data-chat-current-title')
    expect(source).toContain('data-chat-context-close')
    expect(source).toContain('data-chat-context-reopen')
    expect(source).toContain('isOpen={managementOpen')
    expect(source).toContain('data-session-context')
    expect(source).toContain('min-h-0 flex-1 gap-1 overflow-y-auto')
    expect(source).toContain('overflow-y-auto')
    expect(source).toContain('min-w-0 max-w-full overflow-hidden')
    expect(source).toContain('break-words whitespace-pre-wrap')
  })

  it('历史条目显示时间和右键生命周期操作，Session Context 使用可读名称', () => {
    const source = read('views/ChatView.tsx')

    expect(source).toContain('onContextMenu={(event) => openHistoryContextMenu(event, item)}')
    expect(source).toContain("t('pinChat')")
    expect(source).toContain("t('unpinChat')")
    expect(source).toContain("t('archiveChat')")
    expect(source).toContain('formatDateTime(historyItemUpdatedAt(item), currentLocale())')
    expect(source).toContain('sessionDisplayName(item)')
    expect(source).not.toContain('{item.agent} · {item.id}</strong>')
  })

  it('Session Context 列表占满右栏剩余高度', () => {
    const source = read('views/ChatView.tsx')

    expect(source).toContain('grid-rows-[3rem_minmax(0,1fr)]')
    expect(source).toContain('grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]')
    expect(source).toContain('data-session-context-list')
    expect(source).toContain('ResizeObserver')
    expect(source).toContain('virtualWindowRange')
    expect(source).not.toContain("t('privacy')")
    expect(source).not.toContain('grid-rows-[3rem_minmax(0,1fr)_auto]')
    expect(source).not.toContain('const viewportHeight = 290')
    expect(source).not.toContain('style={{ height: viewportHeight }}')
  })

  it('Session Context 可全选和取消全选当前筛选结果', () => {
    const source = read('views/ChatView.tsx')

    expect(source).toContain('toggleAvailableSessionSelection')
    expect(source).toContain("allItemsSelected ? t('deselectAll') : t('selectAll')")
    expect(source).toContain('data-session-context-select-all')
  })

  it('Session Context 固定已选区域并标明筛选区', () => {
    const source = read('views/ChatView.tsx')

    expect(source).toContain('flex h-44 flex-col border-b border-border p-4')
    expect(source).toContain('data-session-context-selected')
    expect(source).toContain("t('sessionFilters')")
    expect(source).toContain("t('noSelectedSessions')")
    expect(source).not.toContain('selected.length > 0 && (')
  })

  it('Composer 保留完整运行能力并按原型划分左右操作组', () => {
    const source = read('views/ChatView.tsx')

    expect(source).toContain('data-composer-options')
    expect(source).toContain('<ChatSkillPicker')
    expect(source).toContain('data-composer-context')
    expect(source).toContain('data-composer-runtime')
    expect(source).toContain('data-composer-fast-mode')
    expect(source).toContain('data-composer-actions')
    expect(source).toContain('flex min-h-11 min-w-0 items-center')
    expect(source.match(/h-8 min-h-8/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
    expect(source).toContain('border-l border-border pl-3')
    expect(source).toContain('<Tooltip delay={0}>')
    expect(source).toContain('<Tooltip.Trigger')
    expect(source).toContain('data-context-usage-trigger')
    expect(source).toContain('formatContextUsage(contextUsage, contextPercent)')
    expect(source).toContain("t('fullAccess')")
    expect(source).toContain('liveUsage')
    expect(source).toContain('stopChatTurn')
    expect(source).toContain('queueRef.current')
  })

  it('Composer Skills 使用可搜索多选 Picker 而不是普通 Select', () => {
    const source = read('views/ChatView.tsx')
    const picker = read('views/ChatSkillPicker.tsx')

    expect(source).toContain('<ChatSkillPicker')
    expect(source).toContain('data-composer-skills')
    expect(source).toContain('composeMessageWithSkills')
    expect(source).toContain('consumeSkillPickerTrigger')
    expect(source).toContain('setSelectedSkills([])')
    expect(picker).toContain('data-skill-picker')
    expect(picker).toContain("t('searchSkillsPlaceholder')")
    expect(picker).toContain('aria-multiselectable="true"')
    expect(picker).toContain("event.key === 'ArrowDown'")
    expect(picker).toContain("event.key === 'Enter'")
    expect(picker).toContain('h-[min(32rem,calc(100vh-8rem))]')
  })

  it('Chat 直接展示 Activity timeline、elapsed，并只在 completed 后展示 Rules', () => {
    const source = read('views/ChatView.tsx')

    expect(source).not.toContain('<details')
    expect(source).toContain('ActivityTimeline')
    expect(source).toContain('formatElapsed')
    expect(source).toContain('startedAt={liveStartedAt ?? undefined}')
    expect(source).toContain('mergeLiveTimeline(current, event)')
    expect(source).toContain('data-native-turn-timeline')
    expect(source).toContain('shouldFollowStream')
    expect(source).toContain("thread.status === 'completed'")
    expect(source).toContain('visibleProjectResponses')
  })

  it('Chat 失败终态可复用原请求重新生成并进入新 Thread', () => {
    const source = read('views/ChatView.tsx')

    expect(source).toContain('canRegenerate(thread.status)')
    expect(source).toContain("t('regenerate')")
    expect(source).toContain("'rules.generate',")
    expect(source).toContain('thread.request')
    expect(source).toContain('await refresh(result.runId)')
    expect(source).toContain('isRegenerating')
  })

  it('Chat 移除 Assistant 外壳并支持展开 Activity 正文', () => {
    const source = read('views/ChatView.tsx')
    const conversation = source.slice(
      source.indexOf('function PersistedConversation'),
      source.indexOf('function LegacyConversation'),
    )

    expect(conversation).not.toContain('<Bot')
    expect(conversation).not.toContain("t('assistant')")
    expect(conversation).not.toContain('statusColor')
    expect(conversation).toContain('ActivityRow')
    expect(conversation).toContain('expandedActivityIds')
    expect(conversation).toContain('whitespace-pre-wrap')
    expect(conversation).toContain('mergeTimelineActivities')
  })

  it('Scan 拆分最近结果与新建扫描配置', () => {
    const source = read('views/OverviewView.tsx')
    expect(source).toContain("'latest'")
    expect(source).toContain("'create'")
    expect(source).toContain('selectedAgents')
    expect(source).toContain("t('latest.completedAt'")
    expect(source).toContain("t('latest.configureFirst')")
    expect(source).toContain("useState<ScanRange>('full')")
    expect(source).toContain('sinceDays')
    expect(source).toContain("t('create.fullHistory')")
    expect(source).toContain("t('create.lastDays')")
  })

  it('Scan 结果整行可进入对应 Project 的 Sessions', () => {
    const scanSource = read('views/OverviewView.tsx')
    const projectsSource = read('views/ProjectsView.tsx')
    expect(scanSource).toContain('onRowAction={(key) => onOpenProject?.(String(key))}')
    expect(scanSource).toContain("t('latest.viewProjectSessions'")
    expect(scanSource).toContain('cursor-pointer')
    expect(scanSource).toContain("t('latest.viewSessions')")
    expect(projectsSource).toContain("initialTab = 'sessions'")
    expect(projectsSource).toContain('useState<DetailTab>(initialTab)')
  })

  it('Scan 提供全部 History 并可查看历史结果与扫描范围', () => {
    const scanSource = read('views/OverviewView.tsx')
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')
    expect(scanSource).toContain("'history'")
    expect(scanSource).toContain("'scan.history'")
    expect(scanSource).toContain("t('history.title')")
    expect(scanSource).toContain("t('history.all')")
    expect(scanSource).toContain('formatScanScope(entry.scope)')
    expect(scanSource).toContain('selectedHistory')
    expect(scanSource).toContain('isMissingScanHistoryHandler')
    expect(scanSource).toContain("i18n.t('scan:errors.historyVersion')")
    expect(ipcSource).toContain("ipcMain.handle('scan.history'")
  })

  it('Projects 拆分列表和详情并使用虚拟 Sessions 列表', () => {
    const source = read('views/ProjectsView.tsx')
    expect(source).toContain("'list'")
    expect(source).toContain("'detail'")
    expect(source).toContain('VirtualSessionList')
    expect(source).toContain('onRowAction={(key) =>')
    expect(source).toContain('hover:bg-surface-hover')
    expect(source).toContain('focus-visible:bg-surface-hover')
    expect(source).toContain('[&>td]:rounded-none')
    expect(source).toContain('sessionQuery')
    expect(source).toContain('filterProjectSessions')
    expect(source).toContain('SessionDetails')
    expect(source).toContain('onOpen')
    expect(source).toContain('className="grid w-full cursor-pointer grid-cols-')
    expect(source).toContain("window.api.invoke('projects.reveal'")
    expect(source).toContain("window.api.invoke('sessions.reveal'")
    expect(source).toContain("t('details.openProjectLocation')")
    expect(source).toContain("t('sessions.openLocation')")
  })

  it('Session 详情使用 Projects / project / session 面包屑并处理旧主进程', () => {
    const source = read('views/ProjectsView.tsx')
    expect(source).toContain("aria-label={t('breadcrumbs.label')}")
    expect(source).toContain('onBackToProjects')
    expect(source).toContain('projectSlug')
    expect(source).toContain('isMissingIpcHandler')
    expect(source).toContain("i18n.t('projects:errors.previewVersion')")
  })

  it('Session preview handler 和 Worker 一起进入主进程构建', () => {
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')
    const viteSource = fs.readFileSync(path.join(appRoot, 'electron.vite.config.ts'), 'utf8')
    expect(ipcSource).toContain("ipcMain.handle('sessions.preview'")
    expect(ipcSource).toContain("ipcMain.handle('sessions.evidenceContext'")
    expect(ipcSource).toContain('runSessionPreviewWorker(sessionId)')
    expect(viteSource).toContain("'session-preview-worker'")
  })

  it('项目 Session 列表在独立 Worker 中解析，避免阻塞主进程', () => {
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')
    const viteSource = fs.readFileSync(path.join(appRoot, 'electron.vite.config.ts'), 'utf8')
    const workerSource = fs.readFileSync(
      path.join(appRoot, 'main/project-sessions-worker.ts'),
      'utf8',
    )

    expect(ipcSource).toContain("ipcMain.handle('projects.sessions'")
    expect(ipcSource).toContain('runProjectSessionsWorker(slug)')
    expect(ipcSource).not.toContain('return listProjectSessions({ slug })')
    expect(viteSource).toContain("'project-sessions-worker'")
    expect(workerSource).toContain('listProjectSessions({ slug })')
  })

  it('Rules 拆分 Overview、Agent instruction、生成、审核与输出页面', () => {
    const appSource = read('App.tsx')
    const source = read('views/RulesView.tsx')
    expect(source).toContain("'overview'")
    expect(source).toContain("'agent'")
    expect(source).toContain("'generate'")
    expect(source).toContain("'review'")
    expect(source).toContain("'output'")
    expect(source).toContain("'changed7d'")
    expect(source).toContain("tr('scope.changed')")
    expect(appSource).toContain("t('rulesLabel')")
    expect(appSource).toContain("labelKey: 'agentInstructions'")
    expect(appSource).toContain("labelKey: 'generatedRules'")
    expect(appSource).not.toContain("labelKey: 'generationHistory'")
    expect(source).toContain("section === 'agents'")
    expect(source).toContain("section === 'generated'")
    expect(source).not.toContain("section === 'history'")
    expect(source).toContain('selectedRunId')
    expect(source).toContain('<Select')
    expect(source).toContain('filterCandidatesByRun')
    expect(appSource).toContain('onOpenGeneratedRules={(runId)')
  })

  it('候选审核直接展示来源 Session 的 Evidence 命中上下文，不展示 locator JSON', () => {
    const source = read('views/RulesView.tsx')
    const reviewPage = source.slice(
      source.indexOf('function ReviewRulePage'),
      source.indexOf('function PublishRulesPage'),
    )

    expect(reviewPage).toContain('<EvidenceSourceContexts evidence={evidence}')
    expect(reviewPage).toContain("'sessions.evidenceContext'")
    expect(reviewPage).toContain('data-evidence-source-contexts')
    expect(reviewPage).toContain("tr('review.evidenceHit')")
    expect(reviewPage).toContain("tr('review.existingRuleBaseline')")
    expect(reviewPage).toContain('load.context.eligibility')
    expect(reviewPage).not.toContain("tr('fields.evidenceReferences')")
  })

  it('候选规则列表支持当前可见范围多选与事务型批量状态更新', () => {
    const source = read('views/RulesView.tsx')
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')
    const generatedPage = source.slice(
      source.indexOf('function GeneratedRulesIndexPage'),
      source.indexOf('function GenerationHistoryIndexPage'),
    )

    expect(ipcSource).toContain("ipcMain.handle('rules.batchUpdateStatus'")
    expect(ipcSource).toContain('updateRuleCandidatesStatus(ids, status)')
    expect(generatedPage).toContain('<Checkbox')
    expect(generatedPage.match(/<Checkbox\.Content/g)).toHaveLength(2)
    expect(generatedPage.match(/<Checkbox\.Control/g)).toHaveLength(2)
    expect(generatedPage.match(/<Checkbox\.Indicator/g)).toHaveLength(2)
    expect(generatedPage).toContain('isIndeterminate')
    expect(generatedPage).toContain('onRowAction={(key) => {')
    expect(generatedPage).toContain('toggleCandidateSelection(String(key))')
    expect(generatedPage).toContain('cursor-pointer rounded-none outline-none transition-colors hover:bg-surface-hover')
    expect(generatedPage).toContain('if (pendingBatchAction !== null) return')
    expect(generatedPage).toContain("tr('generated.bulkAccept')")
    expect(generatedPage).toContain("tr('generated.bulkReject')")
    expect(generatedPage).toContain('setSelectedIds(new Set())')
    expect(generatedPage.match(/slot="selection"/g)).toHaveLength(2)
  })

  it('候选规则行内动作遵循草稿审核、已接受发布、已拒绝查看', () => {
    const source = read('views/RulesView.tsx')
    const generatedPage = source.slice(
      source.indexOf('function GeneratedRulesIndexPage'),
      source.indexOf('function GenerationHistoryIndexPage'),
    )

    expect(generatedPage).toContain("candidate.status === 'accepted'")
    expect(generatedPage).toContain('onPress={onOpenOutput}')
    expect(generatedPage).toContain("tr('actions.publish')")
    expect(generatedPage).toContain("candidate.status === 'draft' ? 'actions.review' : 'actions.view'")
  })

  it('Recent activity 直接按 Session updated_at 收集，不依赖 Scan History', () => {
    const workerSource = fs.readFileSync(
      path.join(appRoot, 'main/generation-worker.ts'),
      'utf8',
    )
    expect(workerSource).toContain('updatedSince')
    expect(workerSource).not.toContain('listChangedSessionIds')
    expect(workerSource).not.toContain('rounds: 30')
    const rulesSource = read('views/RulesView.tsx')
    expect(rulesSource).not.toContain('snapshot.rounds ?? 30')
    const mainSource = fs.readFileSync(path.join(appRoot, 'main/index.ts'), 'utf8')
    expect(mainSource).toContain('cleanupStaleEvidenceContexts()')
  })

  it('Rules 子页面不重复 PageHeader 与 Start Generate', () => {
    const source = read('views/RulesView.tsx')
    const agentPage = source.slice(
      source.indexOf('function AgentInstructionsIndexPage'),
      source.indexOf('function GeneratedRulesIndexPage'),
    )
    const generatedPage = source.slice(
      source.indexOf('function GeneratedRulesIndexPage'),
      source.indexOf('function GenerationHistoryIndexPage'),
    )
    const historyPage = source.slice(
      source.indexOf('function GenerationHistoryIndexPage'),
      source.indexOf('function AgentInstructionDetailPage'),
    )

    for (const page of [agentPage, generatedPage, historyPage]) {
      expect(page).not.toContain('<PageHeader')
      expect(page).not.toContain('<StartGenerateButton')
    }
    const dashboard = source.slice(
      source.indexOf('function RulesDashboardPage'),
      source.indexOf('function AgentInstructionsIndexPage'),
    )
    expect(dashboard).toContain('<PageHeader')
    expect(dashboard).toContain("tr('actions.startGenerate')")
  })

  it('Rules 通过 IPC 管理五个 Agent instruction 文件且不展示 Cursor', () => {
    const source = read('views/RulesView.tsx')
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')

    expect(ipcSource).toContain("ipcMain.handle('rules.instructions.list'")
    expect(ipcSource).toContain("ipcMain.handle('rules.instructions.read'")
    expect(ipcSource).toContain("ipcMain.handle('rules.instructions.save'")
    expect(ipcSource).toContain("ipcMain.handle('rules.updateText'")
    expect(ipcSource).toContain("ipcMain.handle('rules.publishAgents'")
    expect(source).toContain("tr('instructions.title')")
    expect(source).toContain('Claude')
    expect(source).toContain('Codex')
    expect(source).toContain('Copilot')
    expect(source).toContain('OpenCode')
    expect(source).toContain('Pi')
    expect(source).toContain("tr('publish.noDefault')")
    expect(source).toContain("tr('publish.results')")
    expect(source).not.toContain('Cursor global instructions')
  })

  it('Rules 保留 Agent 指令并新增只读 Agent Memory 入口', () => {
    const appSource = read('App.tsx')
    const source = read('views/RulesView.tsx')
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')

    expect(appSource).toContain("{ id: 'agents', labelKey: 'agentInstructions' }")
    expect(appSource).toContain("{ id: 'memories', labelKey: 'agentMemory' }")
    expect(ipcSource).toContain("ipcMain.handle('rules.memories.list'")
    expect(ipcSource).toContain("ipcMain.handle('rules.memories.read'")
    expect(ipcSource).toContain('isAutoMemoryAgent(agent)')
    expect(ipcSource).toContain('readAutoMemorySource(agent, memoryId)')
    expect(source).toContain('AgentMemoryIndexPage')
    expect(source).toContain('AgentMemoryDetailPage')
    expect(source).toContain("'rules.memories.list'")
    expect(source).toContain("'rules.memories.read'")
    const memoryPage = source.slice(
      source.indexOf('function AgentMemoryIndexPage'),
      source.indexOf('function GeneratedRulesIndexPage'),
    )
    expect(memoryPage).not.toContain('rules.memories.save')
    expect(memoryPage).not.toContain('<textarea')
  })

  it('已接受的项目规则可显式发布到一个 Claude Project Memory', () => {
    const source = read('views/RulesView.tsx')
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')
    const outputPage = source.slice(
      source.indexOf('function OutputRulesPage'),
      source.indexOf('type GenerationEventMetadata'),
    )

    expect(ipcSource).toContain("ipcMain.handle('rules.memories.publishTargets'")
    expect(ipcSource).toContain("ipcMain.handle('rules.memories.publishProjectRules'")
    expect(ipcSource).toContain('publishProjectRulesToClaudeMemory')
    expect(outputPage).toContain("'rules.memories.publishTargets'")
    expect(outputPage).toContain("'rules.memories.publishProjectRules'")
    expect(outputPage).toContain('selectedProjectRuleIds')
    expect(outputPage).toContain('expectedTopicRevision')
    expect(outputPage).toContain("tr('publish.projectMemoryDescription')")
  })

  it('项目规则导出只写当前项目，并明确区别于 Agent 和 Memory 发布', () => {
    const source = read('views/RulesView.tsx')
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')
    const outputPage = source.slice(
      source.indexOf('function OutputRulesPage'),
      source.indexOf('type GenerationEventMetadata'),
    )

    expect(ipcSource).toContain("ipcMain.handle('rules.output', (_event, projectSlug: unknown)")
    expect(ipcSource).toContain('runRulesOutput({ project: projectSlug })')
    expect(ipcSource).not.toContain('runRulesOutput({ all: true })')
    expect(outputPage).toContain("window.api.invoke<string[]>('rules.output', selectedProjectSlug)")
    expect(outputPage).toContain("tr('publish.projectOutputDescription'")
    expect(outputPage).toContain('items-start')
    expect(outputPage).toContain('minmax(24rem,26rem)')
    expect(outputPage).toContain('max-h-[calc(100dvh-2rem)]')
    expect(outputPage).toContain('overflow-x-hidden overflow-y-auto')
  })

  it('已接受的项目规则可按显式 cwd 提交到 Codex ad-hoc Memory', () => {
    const source = read('views/RulesView.tsx')
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')
    const workerSource = fs.readFileSync(
      path.join(appRoot, 'main/codex-memory-targets-worker.ts'),
      'utf8',
    )
    const viteSource = fs.readFileSync(path.join(appRoot, 'electron.vite.config.ts'), 'utf8')
    const outputPage = source.slice(
      source.indexOf('function OutputRulesPage'),
      source.indexOf('type GenerationEventMetadata'),
    )

    expect(ipcSource).toContain("ipcMain.handle('rules.memories.codexProjectTargets'")
    expect(ipcSource).toContain("ipcMain.handle('rules.memories.publishCodexProjectRules'")
    expect(ipcSource).toContain('publishProjectRulesToCodexMemory')
    expect(ipcSource).toContain('runCodexMemoryTargetsWorker(projectSlug)')
    expect(workerSource).toContain('listCodexProjectMemoryPublishTargets(projectSlug)')
    expect(viteSource).toContain("'codex-memory-targets-worker'")
    expect(outputPage).toContain("'rules.memories.codexProjectTargets'")
    expect(outputPage).toContain("'rules.memories.publishCodexProjectRules'")
    expect(outputPage).toContain('selectedCodexWorkingDirectory')
    expect(outputPage).toContain('expectedContractRevision')
    expect(outputPage).toContain("tr('publish.codexProjectMemoryDescription')")
  })

  it('Rules Generate 在后台 Worker 运行并提供可恢复、可取消的流式详情页', () => {
    const source = read('views/RulesView.tsx')
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')
    const viteSource = fs.readFileSync(path.join(appRoot, 'electron.vite.config.ts'), 'utf8')

    expect(ipcSource).toContain("ipcMain.handle('rules.generate.status'")
    expect(ipcSource).toContain('generationController.start(generation)')
    expect(ipcSource).not.toContain('await runRulesGenerate')
    expect(viteSource).toContain("'generation-worker'")
    expect(source).toContain("'rules.generate.status'")
    expect(source).toContain("'generate.event'")
    expect(source).toContain("'rules.generate.cancel'")
    expect(source).toContain('GenerationRunPage')
    expect(source).toContain("tr('evidence.agentOutput')")
    expect(source).toContain('Evidence')
    expect(source).toContain("tr('actions.stopGeneration')")
    expect(source).toContain("tr('actions.viewGeneration')")
    expect(source).not.toContain('CompactGenerationStatus')
  })

  it('Generation Run 使用 Chat 主视图、顶部阶段和右侧 Run context', () => {
    const source = read('views/RulesView.tsx')

    expect(source).not.toContain('aria-label="Generation run content"')
    expect(source).not.toContain("useState<'output' | 'evidence'>")
    expect(source).toContain("aria-label={tr('run.progressLabel')}")
    expect(source).toContain("tr('run.context')")
    expect(source).toContain("tr('run.snapshotDescription')")
    expect(source).toContain('grid-cols-[minmax(0,1fr)_18rem]')
    expect(source).toContain('data-phase={phase.key}')
    expect(source).toContain('setSelectedPhase(phase.key)')
    expect(source).toContain('ProjectResponseConversation')
    expect(source).toContain('CandidateDetailsModal')
    expect(source).toContain('projectResponses')
    expect(source).toContain('<summary')
    expect(source).toContain("tr('run.diagnostic')")
  })

  it('新 Generation Run 默认从 Prepare evidence 开始，旧 Run 恢复记忆阶段', () => {
    const source = read('views/RulesView.tsx')

    expect(source).toContain("remembered?.phase ?? 'evidence'")
    expect(source).toContain('generationRunMemory.get(generation.runId)')
    expect(source).toContain('phase: selectedPhase')
  })

  it('Candidate 详情显示 Project，并支持右上角 X 与 Esc 关闭', () => {
    const source = read('views/RulesView.tsx')

    expect(source).toContain("tr('evidence.project', { project: projectSlug })")
    expect(source).toContain("aria-label={tr('actions.closeCandidate')}")
    expect(source).toContain('<X aria-hidden="true"')
    expect(source).toContain("event.key === 'Escape'")
    expect(source).toContain("window.addEventListener('keydown', onKeyDown)")
    expect(source).toContain("window.removeEventListener('keydown', onKeyDown)")
  })

  it('Evidence collecting 展示一份跨项目快照而不是逐项目收集队列', () => {
    const source = read('views/RulesView.tsx')

    expect(source).toContain("tr('evidence.oneSnapshot')")
    expect(source).toContain("tr('evidence.insideSnapshot')")
    expect(source).toContain('EvidenceCollectionView')
    expect(source).not.toContain('Collecting cloud-code-master evidence')
  })

  it('Recent generations 的历史行可重新打开 Chat、Evidence 与候选状态', () => {
    const source = read('views/RulesView.tsx')
    const historySource = fs.readFileSync(
      path.join(appRoot, 'main/generation-history.ts'),
      'utf8',
    )

    expect(source).toContain("'history'")
    expect(source).toContain('HistoricalGenerationPage')
    expect(source).toContain('onOpenHistory')
    expect(source).toContain("tr('history.snapshotTitle')")
    expect(source).toContain('candidate.status')
    expect(historySource).toContain('WHERE run_id = ?')
    expect(historySource).toContain('projects: value.projects.flatMap')
  })

  it('Start Generate 直接进入 Chat 并在对话中选择 Evidence scope', () => {
    const source = read('views/RulesView.tsx')
    const chatSource = read('views/ChatView.tsx')

    expect(source).toContain("tr('generate.evidenceTitle')")
    expect(source).toContain("tr('generate.runConfiguration')")
    expect(source).toContain("labelKey: 'generate.modes.recent.label'")
    expect(source).toContain("'rules.chat.start'")
    expect(source).toContain('onStarted(result.chatId)')
    expect(chatSource).toContain('thread.rulesArtifact')
    expect(source).toContain("tr('generate.agent')")
    expect(source).toContain("tr('generate.model')")
    expect(source).toContain("tr('generate.effort')")
    expect(source).toContain("tr('generate.fastMode')")
    expect(source).toContain("'settings.providers.snapshot'")
    expect(source).toContain('provider,')
    expect(source).toContain('model,')
    expect(source).toContain('effort,')
    expect(source).toContain('fastMode,')
    expect(source).toContain("import { PageShell } from '../components/PageShell'")
    expect(source).toContain("import { SupportingPaneLayout } from '../components/SupportingPaneLayout'")
    expect(source).toContain('archetype="task"')
    expect(source).toContain('paneWidth="lg"')
    expect(source).toContain('data-generation-action="true"')
    expect(source).not.toContain('grid min-h-[34rem] p-0')
    expect(chatSource).toContain("label={t('agent')}")
    expect(chatSource).toContain("label={t('model')}")
    expect(chatSource).toContain("label={t('effort')}")
    expect(chatSource).toContain("aria-label={t('fastMode')}")
    expect(read('views/ChatSkillPicker.tsx')).not.toContain("t('fastMode')")
  })

  it('Rules Dashboard 使用任务摘要和统一状态辅助栏', () => {
    const source = read('views/RulesView.tsx')
    const dashboard = source.slice(
      source.indexOf('function RulesDashboardPage'),
      source.indexOf('function AgentInstructionsIndexPage'),
    )

    expect(source).toContain("import { PageSection } from '../components/PageSection'")
    expect(dashboard).toContain('<PageShell')
    expect(dashboard).toContain('archetype="dashboard"')
    expect(dashboard).toContain('width="wide"')
    expect(dashboard).toContain('<SupportingPaneLayout')
    expect(dashboard).toContain('paneWidth="md"')
    expect(dashboard).toContain('data-dashboard-summary="true"')
    expect(dashboard).toContain('data-dashboard-status-pane="true"')
    expect(dashboard).not.toContain('<MetricStrip')
    expect(dashboard).not.toContain('mt-7 flex items-center justify-between gap-4 border-y')
    expect(dashboard).not.toContain('grid-cols-[minmax(0,1fr)_19rem]')
  })

  it('Scan 运行可取消，取消后继续展示最近一次完成结果', () => {
    const source = read('views/OverviewView.tsx')
    const ipcSource = fs.readFileSync(path.join(appRoot, 'main/ipc.ts'), 'utf8')

    expect(source).toContain("'scan.cancelled'")
    expect(source).toContain("'scan.cancel'")
    expect(source).toContain("t('progress.stop')")
    expect(source).toContain("t('progress.cancelling')")
    expect(source).toContain('restoreLatestScan')
    expect(ipcSource).toContain("ipcMain.handle('scan.cancel'")
    expect(ipcSource).toContain('markInterruptedBackgroundRuns')
  })

  it('Fast Mode 同时适用于 Claude 与 Codex', () => {
    const source = read('views/SettingsView.tsx')
    expect(source).toContain('Claude · Codex')
    expect(source).toContain("aria-label={t('providers.fastModeLabel')}")
    expect(source).not.toContain("config.provider !== 'claude'")
    expect(source).not.toContain('your Claude plan')
  })
})
