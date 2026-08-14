import { AUTO_PERMISSIONS_MESSAGE_PREFIX, normalizeAskedEvent, normalizeRepliedEvent } from "./context.ts"
import type { PermissionRequest, RuntimeContext } from "./types.ts"

type Handler = (event: unknown) => void

export function createStableRuntime(
  injectedClient: unknown,
  options: Readonly<Record<string, unknown>>,
  directory: string,
) {
  const client = compatibleClient(injectedClient)
  const listeners = new Map<string, Set<Handler>>()
  const sessions = new Map<string, { id: string; parentID?: string }>()
  const messages = new Map<string, unknown[]>()
  const pending = new Map<string, PermissionRequest>()
  const resumeControllers = new Set<AbortController>()

  const on = (type: string, handler: Handler) => {
    const handlers = listeners.get(type) ?? new Set<Handler>()
    handlers.add(handler)
    listeners.set(type, handlers)
    return () => handlers.delete(handler)
  }

  const dispatch = (type: string, event: unknown) => {
    for (const handler of listeners.get(type) ?? []) handler(event)
  }

  const syncMessages = async (sessionID: string) => {
    const result = unwrap(await client.session.messages({ path: { id: sessionID }, query: { directory, limit: 200 } }))
    messages.set(sessionID, Array.isArray(result) ? result : [])
  }

  const syncPermissions = async () => {
    const result = unwrap(await client.permission.list({ directory }))
    if (!Array.isArray(result)) return
    pending.clear()
    for (const value of result) {
      const request = normalizeAskedEvent({ type: "permission.asked", data: value })
      if (request) pending.set(request.id, request)
    }
  }

  const root = async (sessionID: string) => {
    const seen = new Set<string>()
    let current = sessionID
    while (!seen.has(current)) {
      seen.add(current)
      let session = sessions.get(current)
      if (!session) {
        const result = unwrap(await client.session.get({ path: { id: current }, query: { directory } }))
        if (!isRecord(result) || typeof result.id !== "string") return sessionID
        session = {
          id: result.id,
          ...(typeof result.parentID === "string" ? { parentID: result.parentID } : {}),
        }
        sessions.set(current, session)
      }
      if (!session.parentID) return current
      current = session.parentID
    }
    return sessionID
  }

  const context: RuntimeContext = {
    options,
    client,
    data: {
      on,
      session: {
        root,
        get: (sessionID) => sessions.get(sessionID),
        message: {
          list: (sessionID) => messages.get(sessionID) ?? [],
          get: (sessionID, messageID) =>
            (messages.get(sessionID) ?? []).find((message) => messageIDOf(message) === messageID),
          sync: syncMessages,
        },
        permission: {
          list: (sessionID) => [...pending.values()].filter((request) => request.sessionID === sessionID),
          sync: async () => syncPermissions().catch(() => undefined),
        },
      },
      location: { default: () => ({ directory }) },
    },
    location: { directory },
    showToast(input) {
      if (typeof client.tui?.showToast !== "function") return
      void client.tui.showToast({ directory, ...input }).catch(() => undefined)
    },
    resumeAfterDenial(sessionID, reason) {
      if (typeof client.session?.promptAsync !== "function") return
      const controller = new AbortController()
      resumeControllers.add(controller)
      void waitForIdle(client, sessionID, directory, controller.signal)
        .then((idle) => {
          if (!idle || controller.signal.aborted) return
          return client.session.promptAsync({
            path: { id: sessionID },
            query: { directory },
            body: {
              parts: [{
                type: "text",
                text: `${AUTO_PERMISSIONS_MESSAGE_PREFIX} ${reason} Do not retry the exact blocked action. Continue the task using a safer alternative when possible; ask the user only if no useful safe path remains.`,
              }],
            },
          })
        })
        .catch(() => undefined)
        .finally(() => resumeControllers.delete(controller))
    },
  }

  return {
    context,
    async version(): Promise<string | undefined> {
      if (typeof client.global?.health !== "function") return undefined
      const result = unwrap(await client.global.health())
      return isRecord(result) && typeof result.version === "string" ? result.version : undefined
    },
    emit(event: unknown) {
      const asked = normalizeAskedEvent(event)
      if (asked?.protocol === "stable") {
        pending.set(asked.id, asked)
        dispatch("permission.asked", event)
        return
      }
      const replied = normalizeRepliedEvent(event)
      if (replied) {
        pending.delete(replied.requestID)
        dispatch("permission.replied", event)
      }
    },
    dispose() {
      listeners.clear()
      sessions.clear()
      messages.clear()
      pending.clear()
      for (const controller of resumeControllers) controller.abort()
      resumeControllers.clear()
    },
  }
}

async function waitForIdle(client: any, sessionID: string, directory: string, signal: AbortSignal): Promise<boolean> {
  if (typeof client.session?.status !== "function") {
    await delay(250, signal)
    return !signal.aborted
  }
  for (let attempt = 0; attempt < 50 && !signal.aborted; attempt++) {
    const statuses = unwrap(await client.session.status({ query: { directory } }))
    if (!isRecord(statuses) || !isRecord(statuses[sessionID]) || statuses[sessionID].type === "idle") return true
    await delay(100, signal)
  }
  return false
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export function protocolForVersion(version: string | undefined): "stable" | "v2" | undefined {
  if (!version) return undefined
  if (version.startsWith("0.0.0-beta") || version.startsWith("0.0.0-next")) return "v2"
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10)
  if (!Number.isFinite(major)) return undefined
  return major >= 2 ? "v2" : "stable"
}

function compatibleClient(value: any): any {
  if (isRecord(value)) return value
  throw new Error("OpenCode compatible authenticated client is unavailable")
}

function unwrap(result: any): unknown {
  if (result?.error) throw result.error
  let value = result?.data ?? result
  if (isRecord(value) && "data" in value) value = value.data
  return value
}

function messageIDOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id === "string") return value.id
  return isRecord(value.info) && typeof value.info.id === "string" ? value.info.id : undefined
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
