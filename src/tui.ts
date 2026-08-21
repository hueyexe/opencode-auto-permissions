import { Plugin } from "@opencode-ai/plugin/tui"
import type { Context } from "@opencode-ai/plugin/tui/plugin"
import type { RuntimeContext } from "./types.ts"
import { installReviewer } from "./reviewer.ts"

export const id = "opencode.auto-permissions"

const plugin = Plugin.define({
  id,
  setup(context) {
    return installReviewer(fromContext(context), { protocols: ["v2"] })
  },
})

export const tui = plugin.setup
export default plugin

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
