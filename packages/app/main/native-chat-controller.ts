import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  ChatStore,
  NativeChatProvider,
  NativeTurnConfig,
} from './chat-store.js'
import type {
  ChatRuntimeManager,
  NativeChatEvent,
  NativeToolActivity,
  NativeToolItemPage,
} from './chat-runtime.js'

export interface NativeChatSendRequest {
  chatId?: string
  provider: NativeChatProvider
  message: string
  config: NativeTurnConfig
}

export interface NativeChatSendResult {
  chatId: string
  nativeSessionId: string
}

export interface NativeChatToolReadRequest {
  chatId: string
  itemId: string
  cursor?: number
  limit?: number
}

export interface NativeChatControllerOptions {
  store: ChatStore
  runtime: ChatRuntimeManager
  workingDirectory: string
  createId?: () => string
  now?: () => string
  onEvent?: (envelope: { chatId: string; event: NativeChatEvent }) => void
}

export class NativeChatController {
  private readonly createId: () => string
  private readonly now: () => string

  constructor(private readonly options: NativeChatControllerOptions) {
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async send(request: NativeChatSendRequest): Promise<NativeChatSendResult> {
    const message = request.message.trim()
    if (!message) throw new Error('chat message is required')
    let chatId = request.chatId
    let nativeSessionId: string | null = null
    if (chatId) {
      const thread = this.options.store.readThread(chatId)
      if (!thread || thread.version !== 2) throw new Error('native chat was not found')
      if (thread.provider !== request.provider) throw new Error('chat provider is locked')
      nativeSessionId = thread.nativeSessionId
    } else {
      chatId = this.createId()
      const createdAt = this.now()
      this.options.store.createNativeThread({
        id: chatId,
        provider: request.provider,
        origin: 'chat',
        title: deriveTitle(message),
        createdAt,
        defaultTurnConfig: request.config,
      })
    }

    const startedAt = this.now()
    this.options.store.markNativeTurnRunning(chatId, request.config, startedAt)
    this.options.store.appendNativeMessage(chatId, visibleMessage({
      id: randomUUID(),
      role: 'user',
      content: message,
      at: startedAt,
      turnConfig: request.config,
    }))
    const toolActivities = new Map<string, NativeToolActivity>()
    try {
      const result = await this.options.runtime.sendTurn({
        chatId,
        provider: request.provider,
        nativeSessionId,
        message,
        workingDirectory: this.options.workingDirectory,
        config: request.config,
        onEvent: (event) => {
          if (event.type === 'tool_activity') {
            toolActivities.set(event.activity.itemId, event.activity)
          }
          this.options.onEvent?.({ chatId, event })
        },
      })
      const completedAt = this.now()
      this.options.store.bindNativeSession(chatId, result.nativeSessionId, completedAt)
      if (result.contextUsage) {
        this.options.store.updateContextUsage(chatId, result.contextUsage, completedAt)
      }
      this.options.store.appendNativeMessage(chatId, visibleMessage({
        id: randomUUID(),
        role: 'assistant',
        content: result.content,
        at: completedAt,
        toolActivities: [...toolActivities.values()],
      }))
      return { chatId, nativeSessionId: result.nativeSessionId }
    } catch (error) {
      this.options.store.markNativeTurnFailed(chatId, errorMessage(error), this.now())
      throw error
    }
  }

  interrupt(chatId: string): Promise<void> {
    return this.options.runtime.interrupt(chatId)
  }

  async readToolItem(request: NativeChatToolReadRequest): Promise<NativeToolItemPage> {
    const thread = this.options.store.readThread(request.chatId)
    if (!thread || thread.version !== 2 || !thread.nativeSessionId) {
      throw new Error('native chat was not found')
    }
    const allowed = thread.messages.some((message) =>
      message.toolActivities?.some((activity) => activity.itemId === request.itemId),
    )
    if (!allowed) throw new Error('tool item was not found')
    return this.options.runtime.readToolItem({
      chatId: request.chatId,
      provider: thread.provider,
      nativeSessionId: thread.nativeSessionId,
      itemId: request.itemId,
      cursor: request.cursor ?? 0,
      limit: request.limit ?? 8192,
    })
  }
}

function visibleMessage(input: {
  id: string
  role: ChatMessage['role']
  content: string
  at: string
  turnConfig?: NativeTurnConfig
  toolActivities?: NativeToolActivity[]
}): ChatMessage {
  return {
    id: input.id,
    role: input.role,
    kind: 'text',
    content: input.content,
    status: 'completed',
    createdAt: input.at,
    completedAt: input.at,
    ...(input.turnConfig ? { turnConfig: { ...input.turnConfig } } : {}),
    ...(input.toolActivities && input.toolActivities.length > 0
      ? { toolActivities: input.toolActivities.map((activity) => ({ ...activity })) }
      : {}),
  }
}

function deriveTitle(message: string): string {
  return message.replace(/\s+/g, ' ').slice(0, 80)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
