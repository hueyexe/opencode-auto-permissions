import { Plugin } from "@opencode-ai/plugin/tui"
import type { Context } from "@opencode-ai/plugin/tui/plugin"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/v1/tui"
import type { RuntimeContext } from "./types.ts"
import { installReviewer } from "./reviewer.ts"
import { protocolForVersion } from "./stable.ts"

export const id = "opencode.auto-permissions"

const plugin = Plugin.define({
  id,
  setup(context) {
    return installReviewer(fromContext(context), { protocols: ["v2"] })
  },
})

export const tui: TuiPlugin = async (api, options) => {
  if (await isStableRuntime(api.client)) return
  const dispose = installReviewer(fromLegacyApi(api, options ?? {}), { protocols: ["v2"] })
  api.lifecycle.onDispose(dispose)
}

export default { ...plugin, tui }

function fromContext(context: Context): RuntimeContext {
  return {
    options: context.options,
    client: context.client,
    data: context.data as RuntimeContext["data"],
    ...(context.location ? { location: context.location } : {}),
    showToast(input) {
      context.ui.toast.show(input)
    },
  }
}

async function isStableRuntime(client: Pick<TuiPluginApi, "client">["client"]): Promise<boolean> {
  if (typeof client?.global?.health !== "function") return false
  try {
    const result = await client.global.health()
    const value = (result as { data?: unknown })?.data ?? result
    return protocolForVersion((value as { version?: string })?.version) === "stable"
  } catch {
    return false
  }
}

function fromLegacyApi(api: TuiPluginApi, options: Readonly<Record<string, unknown>>): RuntimeContext {
  return {
    options,
    client: api.client,
    data: {
      on(type, handler) {
        return api.event.on(type as never, handler as never)
      },
      session: {
        root(sessionID) {
          const seen = new Set<string>()
          let current = sessionID
          while (!seen.has(current)) {
            seen.add(current)
            const parentID = api.state.session.get(current)?.parentID
            if (!parentID) return current
            current = parentID
          }
          return sessionID
        },
        get: (sessionID) => api.state.session.get(sessionID),
        message: {
          list: (sessionID) =>
            api.state.session.messages(sessionID).map((info) => ({ info, parts: api.state.part(info.id) })),
          get: (sessionID, messageID) => {
            const info = api.state.session.messages(sessionID).find((message) => message.id === messageID)
            return info ? { info, parts: api.state.part(info.id) } : undefined
          },
          sync: async () => {},
        },
        permission: {
          list: (sessionID) => api.state.session.permission(sessionID) as never,
          sync: async () => {},
        },
      },
      location: {
        default: () => ({ directory: api.state.path.directory }),
      },
    },
    location: { directory: api.state.path.directory },
    showToast: api.ui.toast,
  }
}