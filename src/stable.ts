import { normalizeAskedEvent, normalizeRepliedEvent } from "./context.ts"
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
    },
  }
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
