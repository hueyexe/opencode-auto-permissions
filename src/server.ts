import { Plugin as V2Plugin } from "@opencode-ai/plugin"
import { REVIEWER_AGENT_ID, REVIEWER_SYSTEM_PROMPT, SERVER_REVIEW_MARKER } from "./agent.ts"
import { parseConfig } from "./config.ts"
import { denialContinuation, sameLocation, SERVER_PLUGIN_ID } from "./context.ts"
import { describeError, writeDiagnostic } from "./diagnostics.ts"
import { REVIEWER_DIRECTORY } from "./opencode-client.ts"
import { installReviewer } from "./reviewer.ts"
import { createStableRuntime, protocolForVersion } from "./stable.ts"
import type { PermissionRequest, RuntimeContext } from "./types.ts"

const REVIEWER_DESCRIPTION = "Hidden, no-tool permission reviewer used by OpenCode Auto Permissions."
const MAX_SESSION_CACHE = 256
const MAX_MESSAGE_CACHE = 32
const MAX_PERMISSION_CACHE = 64
const MAX_MESSAGES_PER_SESSION = 200

const v2Plugin = V2Plugin.define({
  id: SERVER_PLUGIN_ID,
  async setup(context) {
    const config = parseConfig(context.options)
    await context.agent.transform((draft) => {
      draft.update(REVIEWER_AGENT_ID, (agent) => {
        if (config.model) agent.model = config.model as unknown as typeof agent.model
        agent.system = REVIEWER_SYSTEM_PROMPT
        agent.description = REVIEWER_DESCRIPTION
        agent.mode = "subagent"
        agent.hidden = true
        agent.steps = 1
        agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
      })
    })
    if (config.runtime === "stable") return
    if (context.location?.directory === REVIEWER_DIRECTORY) return
    if (!supportsServerV2Review(context)) return
    const cleanup = installServerV2Reviewer(context, config.diagnosticsPath)
    if (!cleanup) return
    try {
      // Advertise that this location has an active server reviewer. The TUI
      // fallback checks this marker instead of assuming plugin presence means
      // the server installed a reviewer.
      await context.agent.transform((draft) => {
        draft.update(REVIEWER_AGENT_ID, (agent) => {
          agent.description = `${REVIEWER_DESCRIPTION} ${SERVER_REVIEW_MARKER}`
        })
      })
    } catch (error) {
      cleanup()
      throw error
    }
    return cleanup
  },
})

function supportsServerV2Review(context: unknown): boolean {
  const value = context as Record<string, any>
  return (
    typeof value?.event?.subscribe === "function" &&
    typeof value?.permission?.list === "function" &&
    typeof value?.permission?.reply === "function" &&
    typeof value?.session?.get === "function" &&
    typeof value?.session?.context === "function" &&
    typeof value?.session?.create === "function" &&
    typeof value?.session?.generate === "function" &&
    typeof value?.session?.remove === "function"
  )
}

function installServerV2Reviewer(context: any, diagnosticsPath: string | undefined): () => void {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const sessions = new Map<string, { id: string; parentID?: string; location?: { directory?: string; workspaceID?: string } }>()
  const messages = new Map<string, unknown[]>()
  const permissions = new Map<string, PermissionRequest[]>()
  const abortController = new AbortController()

  const getSession = async (sessionID: string) => {
    const cached = sessions.get(sessionID)
    if (cached) return cached
    const fetched = unwrapServerData(await context.session.get({ sessionID }))
    if (!isRecord(fetched) || typeof fetched.id !== "string") return undefined
    const info = {
      id: fetched.id,
      ...(typeof fetched.parentID === "string" ? { parentID: fetched.parentID } : {}),
      ...(isRecord(fetched.location) ? { location: fetched.location } : {}),
    }
    setBounded(sessions, sessionID, info, MAX_SESSION_CACHE)
    return info
  }

  const root = async (sessionID: string): Promise<string> => {
    const seen = new Set<string>()
    let current = sessionID
    while (!seen.has(current)) {
      seen.add(current)
      const info = await getSession(current).catch(() => undefined)
      if (!info) return sessionID
      if (!info.parentID) return current
      current = info.parentID
    }
    return sessionID
  }

  const runtimeContext: RuntimeContext = {
    options: context.options,
    client: context,
    location: context.location,
    data: {
      on(type, handler) {
        const set = listeners.get(type) ?? new Set<(event: unknown) => void>()
        set.add(handler)
        listeners.set(type, set)
        return () => set.delete(handler)
      },
      session: {
        root,
        get: (sessionID) => sessions.get(sessionID),
        message: {
          list: (sessionID) => messages.get(sessionID) ?? [],
          get: (sessionID, messageID) =>
            (messages.get(sessionID) ?? []).find((message) => isRecord(message) && message.id === messageID),
          sync: async (sessionID) => {
            const list = unwrapServerData(await context.session.context({ sessionID }))
            const bounded = Array.isArray(list) ? list.slice(-MAX_MESSAGES_PER_SESSION) : []
            setBounded(messages, sessionID, bounded, MAX_MESSAGE_CACHE)
          },
        },
        permission: {
          list: (sessionID) => permissions.get(sessionID),
          sync: async (sessionID) => {
            const list = unwrapServerData(await context.permission.list({ sessionID }))
            setBounded(permissions, sessionID, Array.isArray(list) ? list : [], MAX_PERMISSION_CACHE)
          },
        },
      },
      location: { default: () => context.location ?? {} },
    },
    resumeAfterDenial(sessionID, reason, kind) {
      if (typeof context.session?.prompt !== "function") return
      void (async () => {
        const info = await getSession(sessionID).catch(() => undefined)
        if (!info || info.parentID) {
          writeDiagnostic(diagnosticsPath, {
            timestamp: new Date().toISOString(),
            sessionID,
            event: "resume_failed",
            errorMessage: info
              ? "denial continuation skipped for a child session"
              : "denial continuation skipped for an unknown session",
          })
          return
        }
        const text = denialContinuation(reason, kind)
        try {
          await context.session.prompt({ sessionID, text, delivery: "steer" })
          writeDiagnostic(diagnosticsPath, {
            timestamp: new Date().toISOString(),
            sessionID,
            event: "resumed",
            delivery: "steer",
          })
          return
        } catch {
          // Fall back to an idle resume below.
        }
        try {
          await context.session.prompt({ sessionID, text, resume: true })
          writeDiagnostic(diagnosticsPath, {
            timestamp: new Date().toISOString(),
            sessionID,
            event: "resumed",
            delivery: "resume_fallback",
          })
        } catch (error) {
          writeDiagnostic(diagnosticsPath, {
            timestamp: new Date().toISOString(),
            sessionID,
            event: "resume_failed",
            errorMessage: describeError(error).message,
          })
        }
      })()
    },
  }

  const stopReviewer = installReviewer(runtimeContext, { protocols: ["v2"] })
  const stream = context.event.subscribe({
    types: ["permission.asked", "permission.replied"],
    signal: abortController.signal,
  }) as AsyncIterable<unknown>

  void (async () => {
    try {
      for await (const event of stream) {
        if (abortController.signal.aborted) break
        if (!isRecord(event) || typeof event.type !== "string") continue
        if (event.type === "permission.asked") {
          const eventLocation = isRecord(event.location) ? event.location : undefined
          const sessionID = isRecord(event.data) && typeof event.data.sessionID === "string"
            ? event.data.sessionID
            : undefined
          const resolvedLocation = eventLocation ?? (sessionID ? (await getSession(sessionID).catch(() => undefined))?.location : undefined)
          if (resolvedLocation && !sameLocation(resolvedLocation, context.location)) continue
        }
        for (const handler of listeners.get(event.type) ?? []) handler(event)
      }
    } catch {
      // Subscription aborted or closed on plugin disposal.
    }
  })()

  return () => {
    abortController.abort("plugin disposed")
    stopReviewer()
    listeners.clear()
    sessions.clear()
    messages.clear()
    permissions.clear()
  }
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  if (!map.has(key) && map.size >= limit) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

function unwrapServerData(result: unknown): unknown {
  let value = result
  for (let depth = 0; depth < 3 && isRecord(value) && "data" in value; depth++) {
    value = value.data
  }
  return value
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Structural types for the stable v1 server plugin API. The current plugin
 * package dropped the v1 declarations, so the shapes the stable runtime
 * validates and calls are kept locally.
 */
export interface LegacyPluginInput {
  readonly client: unknown
  readonly directory: string
}

export interface LegacyPluginConfig {
  agent?: Record<string, Record<string, unknown>>
}

export interface LegacyChatMessageInput {
  sessionID: string
  agent?: string
  [key: string]: unknown
}

export interface LegacySystemTransformInput {
  sessionID?: string
  [key: string]: unknown
}

export interface LegacyEventInput {
  event: unknown
  [key: string]: unknown
}

export interface LegacyPluginHooks {
  config?(value: LegacyPluginConfig, ...args: unknown[]): Promise<void> | void
  "chat.message"?(input: LegacyChatMessageInput, ...args: unknown[]): Promise<void> | void
  "experimental.chat.system.transform"?(
    input: LegacySystemTransformInput,
    output: { system: string[] },
    ...args: unknown[]
  ): Promise<void> | void
  event?(input: LegacyEventInput, ...args: unknown[]): Promise<void> | void
  dispose?(...args: unknown[]): Promise<void> | void
}

export type LegacyPlugin = (
  input: LegacyPluginInput,
  options?: Readonly<Record<string, unknown>>,
) => Promise<LegacyPluginHooks>

export interface PluginModule {
  id?: string
  setup?: unknown
  server: LegacyPlugin
}

const legacyPlugin: LegacyPlugin = async (input, options = {}) => {
  const config = parseConfig(options)
  const reviewerSessions = new Map<string, ReturnType<typeof setTimeout>>()
  const stable = createStableRuntime(input.client, options, input.directory)
  let stopStableReviewer: (() => void) | undefined
  let detectedProtocol: "stable" | "v2" | undefined
  const ownsStable = async () => {
    if (config.runtime !== "auto") return config.runtime === "stable"
    if (detectedProtocol) return detectedProtocol === "stable"
    const detected = protocolForVersion(await stable.version())
    if (detected) detectedProtocol = detected
    return detected === "stable"
  }
  const startStableReviewer = async () => {
    if (!(await ownsStable())) return false
    stopStableReviewer ??= installReviewer(stable.context, { protocols: ["stable"] })
    return true
  }
  return {
    async config(value: LegacyPluginConfig) {
      value.agent ??= {}
      const reviewer = {
        ...(config.model ? { model: `${config.model.providerID}/${config.model.id}` } : {}),
        ...(config.model?.variant ? { variant: config.model.variant } : {}),
        prompt: REVIEWER_SYSTEM_PROMPT,
        description: "Hidden, no-tool permission reviewer used by OpenCode Auto Permissions.",
        mode: "subagent",
        hidden: true,
        steps: 1,
        // Keep the read tool present so OpenCode's free-tier provenance check
        // accepts reviewer requests; the wildcard permission below still denies
        // every real read.
        tools: { "*": false, read: true },
        permission: { "*": "deny" },
      }
      // The beta runtime accepts wildcard permission keys through its rest
      // schema, but the generated AgentConfig declaration omits that index.
      value.agent[REVIEWER_AGENT_ID] = reviewer
    },
    async "chat.message"(input: LegacyChatMessageInput) {
      if (input.agent !== REVIEWER_AGENT_ID) return
      clearTimeout(reviewerSessions.get(input.sessionID))
      const expiry = setTimeout(() => reviewerSessions.delete(input.sessionID), 60_000)
      expiry.unref()
      reviewerSessions.set(input.sessionID, expiry)
    },
    async "experimental.chat.system.transform"(
      input: LegacySystemTransformInput,
      output: { system: string[] },
    ) {
      if (!input.sessionID || !reviewerSessions.has(input.sessionID)) return
      output.system.splice(0, output.system.length, REVIEWER_SYSTEM_PROMPT)
    },
    async event(input: LegacyEventInput) {
      detectedProtocol ??= protocolForVersion(eventVersion(input.event))
      if (!(await startStableReviewer())) return
      stable.emit(input.event)
    },
    async dispose() {
      stopStableReviewer?.()
      stable.dispose()
      for (const expiry of reviewerSessions.values()) clearTimeout(expiry)
      reviewerSessions.clear()
    },
  }
}

function eventVersion(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined
  const payload = Reflect.get(event, "properties") ?? Reflect.get(event, "data")
  if (typeof payload !== "object" || payload === null) return undefined
  const info = Reflect.get(payload, "info")
  return typeof info === "object" && info !== null && typeof Reflect.get(info, "version") === "string"
    ? Reflect.get(info, "version")
    : undefined
}

const serverPlugin = {
  ...v2Plugin,
  server: legacyPlugin,
} as typeof v2Plugin & PluginModule

export { legacyPlugin }
export default serverPlugin
