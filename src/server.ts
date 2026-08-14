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
        if (config.model) agent.model = config.model
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
    async config(value: Config) {
      value.agent ??= {}
      const reviewer = {
        ...(config.model ? { model: `${config.model.providerID}/${config.model.id}` } : {}),
        ...(config.model?.variant ? { variant: config.model.variant } : {}),
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
} satisfies typeof v2Plugin & PluginModule

export default serverPlugin
