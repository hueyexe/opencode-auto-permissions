import { Plugin as V2Plugin } from "@opencode-ai/plugin"
import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin/v1"
import { REVIEWER_AGENT_ID, REVIEWER_SYSTEM_PROMPT } from "./agent.ts"
import { parseConfig } from "./config.ts"
import { failureCategory, writeDiagnostic } from "./diagnostics.ts"
import { applyDeterministicPolicy } from "./policy.ts"
import { buildReviewPrompt } from "./prompt.ts"
import { installReviewer } from "./reviewer.ts"
import { createStableRuntime, protocolForVersion } from "./stable.ts"
import type { Decision, ReviewInput } from "./types.ts"
import { parseDecision } from "./verdict.ts"

const v2Plugin = V2Plugin.define({
  id: "opencode.auto-permissions.server",
  tui: true,
  async setup(context) {
    const config = parseConfig(context.options)
    await context.agent.transform((draft) => {
      draft.update(REVIEWER_AGENT_ID, (agent) => {
        if (config.model) agent.model = config.model as unknown as typeof agent.model
        agent.system = REVIEWER_SYSTEM_PROMPT
        agent.description = "Hidden, no-tool permission reviewer used by OpenCode Auto Permissions."
        agent.mode = "subagent"
        agent.hidden = true
        agent.steps = 1
        agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
      })
    })
    const current = context as any
    const permission = Reflect.get(current, "permission")
    if (typeof permission?.hook !== "function") return
    writeDiagnostic(config.diagnosticsPath, {
      timestamp: new Date().toISOString(),
      event: "plugin_started",
    })
    const registration = await permission.hook("evaluate", async (event: any) => {
      if (event.effect !== "ask") return
      const started = Date.now()
      writeDiagnostic(config.diagnosticsPath, {
        timestamp: new Date().toISOString(),
        event: "request_received",
        sessionID: event.sessionID,
        protocol: "v2",
        action: event.action,
        resourceCount: event.resources.length,
      })
      try {
        const [messages, session] = await Promise.all([
          current.session.context({ sessionID: event.sessionID }),
          current.session.get({ sessionID: event.sessionID }),
        ])
        const input: ReviewInput = {
          request: {
            action: event.action,
            resources: [...event.resources],
            sessionPatterns: [],
            ...(event.metadata ? { toolInput: event.metadata.input ?? event.metadata } : {}),
          },
          context: {
            rootSessionID: event.sessionID,
            ...(current.location?.directory ? { directory: current.location.directory } : {}),
            userMessages: messages
              .filter((message: any) => message?.type === "user" && typeof message.text === "string")
              .slice(-config.userMessageCount)
              .map((message: any) => message.text),
            ...(config.model ?? session.model ? { model: config.model ?? session.model } : {}),
          },
        }
        let source: "policy" | "model" = "policy"
        let decision: Decision | null = applyDeterministicPolicy(input)
        if (!decision) {
          source = "model"
          const model = config.model ?? session.model
          if (!model) throw new Error("Auto Permissions could not determine the requesting session model")
          const prompt = `${REVIEWER_SYSTEM_PROMPT}\n\n${buildReviewPrompt(input)}\n\nReturn only one JSON object without Markdown fences with exactly these keys: "decision" ("allow", "allow_session", or "deny"), "reasonCode" (lower_snake_case), and "reason" (one sentence).`
          const result = await current.generate.text({ model, prompt })
          decision = parseDecision(JSON.parse(result.text))
        }
        if (!decision) throw new Error("Auto Permissions returned no decision")
        writeDiagnostic(config.diagnosticsPath, {
          timestamp: new Date().toISOString(),
          event: "decision",
          sessionID: event.sessionID,
          protocol: "v2",
          action: event.action,
          resourceCount: event.resources.length,
          elapsedMs: Date.now() - started,
          source,
          decision: decision.kind,
          reasonCode: decision.reasonCode,
          reason: decision.reason,
          shadow: config.shadow,
          replyResult: config.shadow ? "manual" : "replied",
          ...(decision.kind === "allow_session" ? { approvalScope: "once" } : {}),
        })
        if (config.shadow) return
        event.effect = decision.kind === "deny" ? "deny" : "allow"
        event.message = decision.reason
      } catch (error) {
        writeDiagnostic(config.diagnosticsPath, {
          timestamp: new Date().toISOString(),
          event: "failure",
          sessionID: event.sessionID,
          protocol: "v2",
          action: event.action,
          resourceCount: event.resources.length,
          elapsedMs: Date.now() - started,
          failureCategory: failureCategory(error),
        })
        event.effect = "deny"
        event.message = "Automatic permission review failed; continue with a narrower or lower-risk action."
      }
    })
    return () => registration.dispose()
  },
})

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
} as typeof v2Plugin & PluginModule

export { legacyPlugin }
export default serverPlugin
