import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { RuntimeContext } from "./types.ts"
import { installReviewer } from "./reviewer.ts"

export const id = "opencode.auto-permissions"

const plugin = {
  id,
  setup(context: RuntimeContext) {
    return installReviewer(fromCurrentContext(context))
  },
}

export default plugin

export const tui: TuiPlugin = async (api, options) => {
  installReviewer(fromLegacyApi(api, options ?? {}))
}

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
          list: (sessionID) => api.state.session.messages(sessionID) as never,
          get: (sessionID, messageID) =>
            api.state.session.messages(sessionID).find((message) => message.id === messageID) as never,
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
