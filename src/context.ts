import type { PermissionAskedEvent, PermissionRequest, ReviewInput, RuntimeContext } from "./types.ts"

const MAX_MESSAGE_CHARS = 4_000

export function normalizeAskedEvent(event: unknown): PermissionAskedEvent | null {
  if (!isRecord(event) || event.type !== "permission.v2.asked" || !isRecord(event.data)) return null
  const data = event.data
  if (
    typeof data.id !== "string" ||
    typeof data.sessionID !== "string" ||
    typeof data.action !== "string" ||
    !Array.isArray(data.resources) ||
    !data.resources.every((item) => typeof item === "string")
  ) {
    return null
  }
  return event as unknown as PermissionAskedEvent
}

export function normalizeRepliedEvent(event: unknown): { sessionID: string; requestID: string } | null {
  if (!isRecord(event) || event.type !== "permission.v2.replied" || !isRecord(event.data)) return null
  if (typeof event.data.sessionID !== "string" || typeof event.data.requestID !== "string") return null
  return { sessionID: event.data.sessionID, requestID: event.data.requestID }
}

export async function collectReviewInput(
  context: RuntimeContext,
  request: PermissionRequest,
  userMessageCount: number,
): Promise<ReviewInput> {
  const rootSessionID = context.data.session.root(request.sessionID)
  await Promise.all([
    context.data.session.message.sync(rootSessionID),
    request.sessionID === rootSessionID ? Promise.resolve() : context.data.session.message.sync(request.sessionID),
  ])

  const messages = context.data.session.message.list(rootSessionID)
  const userMessages = messages
    .filter((message): message is Extract<(typeof messages)[number], { type: "user" }> => message.type === "user")
    .map((message) => message.text.slice(0, MAX_MESSAGE_CHARS))
    .slice(-userMessageCount)
  const currentDirectory = directory(context)

  return {
    request: {
      action: request.action,
      resources: [...request.resources],
      ...(request.source?.type === "tool"
        ? { toolInput: findToolInput(context, request.sessionID, request.source.messageID, request.source.callID) }
        : {}),
    },
    context: {
      rootSessionID,
      ...(currentDirectory ? { directory: currentDirectory } : {}),
      userMessages,
    },
  }
}

export async function isRequestPending(context: RuntimeContext, request: PermissionRequest): Promise<boolean> {
  await context.data.session.permission.sync(request.sessionID)
  return context.data.session.permission.list(request.sessionID)?.some((item) => item.id === request.id) ?? false
}

function findToolInput(
  context: RuntimeContext,
  sessionID: string,
  messageID: string,
  callID: string,
): unknown {
  const message = context.data.session.message.get(sessionID, messageID)
  if (message?.type !== "assistant") return undefined
  const tool = message.content.find((item) => item.type === "tool" && item.id === callID)
  if (!tool || tool.type !== "tool") return undefined
  return tool.state.input
}

function directory(context: RuntimeContext): string | undefined {
  return context.location?.directory ?? context.data.location?.default().directory
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
