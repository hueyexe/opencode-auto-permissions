import type {
  ModelRef,
} from "@opencode-ai/sdk/v2"

export type ReviewModel = ModelRef
export type PermissionProtocol = "stable" | "v2"

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  source?: { type: "tool"; messageID: string; callID: string }
  protocol: PermissionProtocol
}

export type Decision =
  | { kind: "allow"; reasonCode: string; reason: string }
  | { kind: "deny"; reasonCode: string; reason: string }
  | { kind: "ask"; reasonCode: string; reason: string }

export interface ReviewInput {
  request: {
    action: string
    resources: string[]
    toolInput?: unknown
  }
  context: {
    rootSessionID: string
    directory?: string
    userMessages: string[]
  }
}

export interface SessionData {
  root(sessionID: string): string | Promise<string>
  get(sessionID: string): { id: string; parentID?: string } | undefined
  message: {
    list(sessionID: string): unknown[]
    get(sessionID: string, messageID: string): unknown
    sync(sessionID: string): Promise<void>
  }
  permission: {
    list(sessionID: string): PermissionRequest[] | undefined
    sync(sessionID: string): Promise<void>
  }
}

export interface RuntimeContext {
  options: Readonly<Record<string, unknown>>
  client: unknown
  data: {
    on(type: string, handler: (event: unknown) => void): () => void
    session: SessionData
    location?: {
      default(): { directory?: string; workspaceID?: string }
    }
  }
  location?: { directory?: string; workspaceID?: string }
  showToast?(input: {
    title?: string
    message: string
    variant?: "info" | "success" | "warning" | "error"
    duration?: number
  }): void
  resumeAfterDenial?(sessionID: string, reason: string): void
}

export interface ReviewerClient {
  prewarm?(): Promise<void>
  generate(input: {
    prompt: string
    model: ReviewModel
    parentSessionID: string
    location?: { directory?: string; workspaceID?: string }
    signal: AbortSignal
  }): Promise<unknown>
  reply(input: {
    sessionID: string
    requestID: string
    reply: "once" | "reject"
    message?: string
    protocol: PermissionProtocol
  }): Promise<"replied" | "not_found">
}
