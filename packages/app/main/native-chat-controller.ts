import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  ChatStore,
  NativeChatProvider,
  NativeTurnConfig,
} from './chat-store.js'
import type { ChatRuntimeManager } from './chat-runtime.js'

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

export interface NativeChatControllerOptions {
  store: ChatStore
  runtime: ChatRuntimeManager
  workingDirectory: string
  createId?: () => string
  now?: () => string
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
    try {
      const result = await this.options.runtime.sendTurn({
        chatId,
        provider: request.provider,
        nativeSessionId,
        message,
        workingDirectory: this.options.workingDirectory,
        config: request.config,
      })
      const completedAt = this.now()
      this.options.store.bindNativeSession(chatId, result.nativeSessionId, completedAt)
      this.options.store.appendNativeMessage(chatId, visibleMessage({
        id: randomUUID(),
        role: 'assistant',
        content: result.content,
        at: completedAt,
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
}

function visibleMessage(input: {
  id: string
  role: ChatMessage['role']
  content: string
  at: string
  turnConfig?: NativeTurnConfig
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
  }
}

function deriveTitle(message: string): string {
  return message.replace(/\s+/g, ' ').slice(0, 80)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
