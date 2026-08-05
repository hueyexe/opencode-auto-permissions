import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin"
import type { Plugin as V2Plugin } from "@opencode-ai/plugin/v2/promise"
import { REVIEWER_AGENT_ID, REVIEWER_SYSTEM_PROMPT } from "./agent.ts"
import { parseConfig } from "./config.ts"
import { installReviewer } from "./reviewer.ts"
import { createStableRuntime, protocolForVersion } from "./stable.ts"

const v2Plugin = {
  id: "opencode.auto-permissions.server",
  async setup(context) {
    const config = parseConfig(context.options)
    await context.agent.transform((draft) => {
      draft.update(REVIEWER_AGENT_ID, (agent) => {
        agent.model = config.model
        agent.system = REVIEWER_SYSTEM_PROMPT
        agent.description = "Hidden, no-tool permission reviewer used by OpenCode Auto Permissions."
        agent.mode = "subagent"
        agent.hidden = true
        agent.steps = 1
        agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
      })
    })
  },
} satisfies V2Plugin

const legacyPlugin: Plugin = async (input, options = {}) => {
  const config = parseConfig(options)
  const reviewerSessions = new Map<string, ReturnType<typeof setTimeout>>()
  const stable = createStableRuntime(input.client, options, input.directory)
  let stopStableReviewer: (() => void) | undefined
  let ownership: Promise<boolean> | undefined
  const ownsStable = () =>
    (ownership ??= (async () => {
      if (config.runtime !== "auto") return config.runtime === "stable"
      return protocolForVersion(await stable.version()) === "stable"
    })())
  const startStableReviewer = async () => {
    if (!(await ownsStable())) return false
    stopStableReviewer ??= installReviewer(stable.context, { protocols: ["stable"] })
    return true
  }
  return {
    async config(value: Config) {
      value.agent ??= {}
      const reviewer = {
        model: `${config.model.providerID}/${config.model.id}`,
        ...(config.model.variant ? { variant: config.model.variant } : {}),
        prompt: REVIEWER_SYSTEM_PROMPT,
        description: "Hidden, no-tool permission reviewer used by OpenCode Auto Permissions.",
        mode: "subagent",
        hidden: true,
        steps: 1,
        tools: { "*": false },
        permission: { "*": "deny" },
      }
      // The beta runtime accepts wildcard permission keys through its rest
      // schema, but the generated AgentConfig declaration omits that index.
      value.agent[REVIEWER_AGENT_ID] = reviewer as unknown as NonNullable<Config["agent"]>[string]
    },
    async "chat.message"(input) {
      if (input.agent !== REVIEWER_AGENT_ID) return
      clearTimeout(reviewerSessions.get(input.sessionID))
      const expiry = setTimeout(() => reviewerSessions.delete(input.sessionID), 60_000)
      expiry.unref()
      reviewerSessions.set(input.sessionID, expiry)
    },
    async "experimental.chat.system.transform"(input, output) {
      if (!input.sessionID || !reviewerSessions.has(input.sessionID)) return
      output.system.splice(0, output.system.length, REVIEWER_SYSTEM_PROMPT)
    },
    async event(input) {
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

const serverPlugin = {
  ...v2Plugin,
  server: legacyPlugin,
} satisfies typeof v2Plugin & PluginModule

export default serverPlugin
