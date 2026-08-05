import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { RuntimeContext } from "./types.ts"
import { installReviewer } from "./reviewer.ts"

export const id = "opencode.auto-permissions"

export const tui: TuiPlugin = async (api, options) => {
  const dispose = installReviewer(fromLegacyApi(api, options ?? {}), { protocols: ["v2"] })
  api.lifecycle.onDispose(dispose)
}

const plugin = {
  id,
  tui,
  setup(context: RuntimeContext) {
    return installReviewer(fromCurrentContext(context), { protocols: ["v2"] })
  },
}

export default plugin

function fromCurrentContext(context: RuntimeContext & { ui?: any }): RuntimeContext {
  if (context.showToast) return context
  const client = context.client as any
  return {
    ...context,
    showToast(input) {
      const uiToast = context.ui?.toast?.show ?? context.ui?.toast
      if (typeof uiToast === "function") {
        uiToast(input)
        return
      }
      const direct = client?.tui?.showToast
      if (typeof direct !== "function") return
      void direct(input)
    },
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
