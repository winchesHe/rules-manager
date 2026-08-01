import type {
  NativeChatProvider,
  NativeTurnConfig,
} from './chat-store.js'

export interface NativeTurnRequest {
  chatId: string
  provider: NativeChatProvider
  nativeSessionId?: string | null
  message: string
  workingDirectory: string
  config: NativeTurnConfig
}

export interface NativeTurnResult {
  nativeSessionId: string
  content: string
  contextUsage?: { usedTokens: number; maxTokens: number }
}

export interface ChatProviderAdapter {
  start(request: NativeTurnRequest): Promise<NativeTurnResult>
  resume(request: NativeTurnRequest & { nativeSessionId: string }): Promise<NativeTurnResult>
  interrupt(): Promise<void>
  close(): Promise<void>
}

export type ChatProviderAdapterFactory = (
  provider: NativeChatProvider,
  chatId: string,
) => ChatProviderAdapter

interface ActiveTurn {
  adapter: ChatProviderAdapter
  promise: Promise<NativeTurnResult>
}

export class ChatRuntimeManager {
  private readonly adapters = new Map<string, ChatProviderAdapter>()
  private readonly active = new Map<string, ActiveTurn>()

  constructor(private readonly createAdapter: ChatProviderAdapterFactory) {}

  sendTurn(request: NativeTurnRequest): Promise<NativeTurnResult> {
    if (this.active.has(request.chatId)) {
      return Promise.reject(new Error(`chat ${request.chatId} already has an active turn`))
    }
    const adapter = this.adapters.get(request.chatId)
      ?? this.createAndRememberAdapter(request.provider, request.chatId)
    const operation = request.nativeSessionId
      ? adapter.resume({ ...request, nativeSessionId: request.nativeSessionId })
      : adapter.start(request)
    const promise = Promise.resolve(operation).finally(() => {
      if (this.active.get(request.chatId)?.promise === promise) {
        this.active.delete(request.chatId)
      }
    })
    this.active.set(request.chatId, { adapter, promise })
    return promise
  }

  async interrupt(chatId: string): Promise<void> {
    const turn = this.active.get(chatId)
    if (!turn) return
    await turn.adapter.interrupt()
  }

  activeChatIds(): string[] {
    return [...this.active.keys()].sort()
  }

  async close(chatId?: string): Promise<void> {
    const entries = chatId
      ? [...this.adapters.entries()].filter(([id]) => id === chatId)
      : [...this.adapters.entries()]
    await Promise.all(entries.map(async ([id, adapter]) => {
      await adapter.close()
      this.adapters.delete(id)
      this.active.delete(id)
    }))
  }

  private createAndRememberAdapter(
    provider: NativeChatProvider,
    chatId: string,
  ): ChatProviderAdapter {
    const adapter = this.createAdapter(provider, chatId)
    this.adapters.set(chatId, adapter)
    return adapter
  }
}
