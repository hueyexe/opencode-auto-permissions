import type { PermissionRequest, ReviewInput, ReviewModel, RuntimeContext } from "./types.ts"

const MAX_MESSAGE_CHARS = 4_000
export const AUTO_PERMISSIONS_MESSAGE_PREFIX = "[Auto Permissions] The requested action was blocked:"

export function normalizeAskedEvent(event: unknown): PermissionRequest | null {
  if (!isRecord(event)) return null
  const data = payload(event)
  if (
    event.type === "permission.v2.asked" ||
    (event.type === "permission.asked" && validRequest(data, "action", "resources"))
  ) {
    if (!validRequest(data, "action", "resources")) return null
    return {
      id: data.id,
      sessionID: data.sessionID,
      action: data.action,
      resources: [...data.resources],
      always: stringArray(data.always),
      ...(validTool(data.source) ? { source: data.source } : {}),
      protocol: "v2",
    }
  }

  if (event.type !== "permission.asked" && event.type !== "permission.updated") return null
  if (!data || typeof data.id !== "string" || typeof data.sessionID !== "string") return null
  const action = typeof data.permission === "string" ? data.permission : data.type
  const rawResources = data.patterns ?? data.pattern
  const resources = Array.isArray(rawResources) ? rawResources : typeof rawResources === "string" ? [rawResources] : []
  if (typeof action !== "string" || resources.length === 0 || !resources.every((item) => typeof item === "string"))
    return null
  const tool = validTool(data.tool)
    ? data.tool
    : typeof data.messageID === "string" && typeof data.callID === "string"
      ? { type: "tool" as const, messageID: data.messageID, callID: data.callID }
      : undefined
  return {
    id: data.id,
    sessionID: data.sessionID,
    action,
    resources,
    always: stringArray(data.always),
    ...(tool ? { source: tool } : {}),
    protocol: "stable",
  }
}

export function normalizeRepliedEvent(event: unknown): { sessionID: string; requestID: string } | null {
  if (!isRecord(event) || !["permission.v2.replied", "permission.replied"].includes(String(event.type))) return null
  const data = payload(event)
  const requestID = data?.requestID ?? data?.permissionID
  if (!isRecord(data) || typeof data.sessionID !== "string" || typeof requestID !== "string") return null
  return { sessionID: data.sessionID, requestID }
}

export async function collectReviewInput(
  context: RuntimeContext,
  request: PermissionRequest,
  userMessageCount: number,
): Promise<ReviewInput> {
  const rootSessionID = await context.data.session.root(request.sessionID)
  await Promise.all([
    context.data.session.message.sync(rootSessionID),
    request.sessionID === rootSessionID ? Promise.resolve() : context.data.session.message.sync(request.sessionID),
  ])

  const messages = context.data.session.message.list(rootSessionID)
  const userMessages = messages
    .flatMap((message) => {
      const text = userText(message)
      return text === undefined ? [] : [text.slice(0, MAX_MESSAGE_CHARS)]
    })
    .slice(-userMessageCount)
  const currentDirectory = directory(context)
  const model = latestUserModel(messages)

  return {
    request: {
      action: request.action,
      resources: [...request.resources],
      sessionPatterns: [...request.always],
      ...(request.source?.type === "tool"
        ? { toolInput: findToolInput(context, request.sessionID, request.source.messageID, request.source.callID) }
        : {}),
    },
    context: {
      rootSessionID,
      ...(currentDirectory ? { directory: currentDirectory } : {}),
      userMessages,
      ...(model ? { model } : {}),
    },
  }
}

function latestUserModel(messages: unknown[]): ReviewModel | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!isRecord(message)) continue
    const info = isRecord(message.info) ? message.info : message
    if (info.role !== "user" || !isRecord(info.model)) continue
    const providerID = info.model.providerID
    const id = info.model.modelID ?? info.model.id
    if (typeof providerID !== "string" || typeof id !== "string") continue
    const variant = typeof info.model.variant === "string" ? info.model.variant : undefined
    return { providerID, id, ...(variant ? { variant } : {}) }
  }
  return undefined
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
  if (!isRecord(message)) return undefined

  if (message.type === "assistant" && Array.isArray(message.content)) {
    const tool = message.content.find(
      (item) => isRecord(item) && item.type === "tool" && (item.id === callID || item.callID === callID),
    )
    if (isRecord(tool) && isRecord(tool.state)) return tool.state.input
  }

  if (isRecord(message.info) && message.info.role === "assistant" && Array.isArray(message.parts)) {
    const tool = message.parts.find(
      (part) => isRecord(part) && part.type === "tool" && (part.callID === callID || part.id === callID),
    )
    if (isRecord(tool) && isRecord(tool.state)) return tool.state.input
  }
  return undefined
}

function directory(context: RuntimeContext): string | undefined {
  return context.location?.directory ?? context.data.location?.default().directory
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function payload(event: Record<string, any>): Record<string, any> | null {
  return isRecord(event.data) ? event.data : isRecord(event.properties) ? event.properties : null
}

function validRequest(
  data: Record<string, any> | null,
  actionKey: "action" | "permission",
  resourcesKey: "resources" | "patterns",
): data is Record<string, any> & { id: string; sessionID: string } {
  return Boolean(
    data &&
      typeof data.id === "string" &&
      typeof data.sessionID === "string" &&
      typeof data[actionKey] === "string" &&
      Array.isArray(data[resourcesKey]) &&
      data[resourcesKey].every((item: unknown) => typeof item === "string"),
  )
}

function validTool(value: unknown): value is { type: "tool"; messageID: string; callID: string } {
  return Boolean(
    isRecord(value) &&
      (value.type === undefined || value.type === "tool") &&
      typeof value.messageID === "string" &&
      typeof value.callID === "string",
  )
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function userText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined
  if (message.type === "user" && typeof message.text === "string") {
    return isPluginContinuation(message.text) ? undefined : message.text
  }
  if (!isRecord(message.info) || message.info.role !== "user" || !Array.isArray(message.parts)) return undefined
  const text = message.parts
    .filter(
      (part) =>
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.synthetic !== true &&
        part.ignored !== true,
    )
    .map((part) => part.text)
    .join("\n")
  return text && !isPluginContinuation(text) ? text : undefined
}

function isPluginContinuation(text: string): boolean {
  return text.trimStart().startsWith(AUTO_PERMISSIONS_MESSAGE_PREFIX)
}
