import { BetaClient } from "./beta-client.ts"
import { parseConfig, type Config } from "./config.ts"
import {
  collectReviewInput,
  isRequestPending,
  normalizeAskedEvent,
  normalizeRepliedEvent,
} from "./context.ts"
import { applyDeterministicPolicy } from "./policy.ts"
import { buildReviewPrompt } from "./prompt.ts"
import type { Decision, PermissionRequest, ReviewerClient, RuntimeContext } from "./types.ts"
import { parseDecision } from "./verdict.ts"

const SUPPORTED_ACTIONS = new Set(["shell", "bash", "external_directory"])

export interface ReviewerOverrides {
  client?: ReviewerClient
  onDecision?(request: PermissionRequest, decision: Decision, shadow: boolean): void
  onFailure?(request: PermissionRequest, error: unknown): void
}

export function installReviewer(context: RuntimeContext, overrides: ReviewerOverrides = {}): () => void {
  const config = parseConfig(context.options)
  const client = overrides.client ?? new BetaClient(context.client)
  const inFlight = new Map<string, AbortController>()
  void client.prewarm?.().catch(() => undefined)

  const offReplied = context.data.on("permission.v2.replied", (event) => {
    const reply = normalizeRepliedEvent(event)
    if (reply) inFlight.get(reply.requestID)?.abort("permission resolved")
  })

  const offAsked = context.data.on("permission.v2.asked", (event) => {
    const asked = normalizeAskedEvent(event)
    if (!asked || !SUPPORTED_ACTIONS.has(asked.data.action) || inFlight.has(asked.data.id)) return

    const controller = new AbortController()
    inFlight.set(asked.data.id, controller)
    void reviewAndReply(context, client, config, asked.data, controller.signal, overrides)
      .catch((error) => {
        if (controller.signal.aborted) return
        overrides.onFailure?.(asked.data, error)
        context.showToast?.({
          title: "Auto Permissions unavailable",
          message: "Manual approval required.",
          variant: "warning",
          duration: 4_000,
        })
      })
      .finally(() => {
        if (inFlight.get(asked.data.id) === controller) inFlight.delete(asked.data.id)
      })
  })

  return () => {
    offAsked()
    offReplied()
    for (const controller of inFlight.values()) controller.abort("plugin disposed")
    inFlight.clear()
  }
}

async function reviewAndReply(
  context: RuntimeContext,
  client: ReviewerClient,
  config: Config,
  request: PermissionRequest,
  parentSignal: AbortSignal,
  overrides: ReviewerOverrides,
): Promise<void> {
  const input = await collectReviewInput(context, request, config.userMessageCount)
  if (parentSignal.aborted) return

  const policyDecision = applyDeterministicPolicy(input)
  const decision = policyDecision ?? (await modelDecision(context, client, config, input, parentSignal))
  if (parentSignal.aborted) return

  overrides.onDecision?.(request, decision, config.shadow)
  if (config.shadow) return

  if (decision.kind === "ask") {
    context.showToast?.({
      title: "Manual approval",
      message: decision.reason,
      variant: "info",
      duration: 4_000,
    })
    return
  }

  if (!(await isRequestPending(context, request)) || parentSignal.aborted) return

  if (decision.kind === "allow") {
    await client.reply({ sessionID: request.sessionID, requestID: request.id, reply: "once" })
    return
  }

  await client.reply({
    sessionID: request.sessionID,
    requestID: request.id,
    reply: "reject",
    message: `Auto Permissions blocked this action: ${decision.reason}`,
  })
  context.showToast?.({ title: "Blocked", message: decision.reason, variant: "warning", duration: 4_000 })
}

async function modelDecision(
  context: RuntimeContext,
  client: ReviewerClient,
  config: Config,
  input: Awaited<ReturnType<typeof collectReviewInput>>,
  parentSignal: AbortSignal,
): Promise<Decision> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort("review timed out"), config.timeoutMs)
  const abort = () => timeout.abort(parentSignal.reason)
  parentSignal.addEventListener("abort", abort, { once: true })

  try {
    const structured = await client.generate({
      prompt: buildReviewPrompt(input),
      model: config.model,
      parentSessionID: input.context.rootSessionID,
      ...(input.context.directory ? { location: { directory: input.context.directory } } : {}),
      signal: timeout.signal,
    })
    const decision = parseDecision(structured)
    if (!decision) throw new Error("Reviewer returned an invalid decision")
    return decision
  } finally {
    clearTimeout(timer)
    parentSignal.removeEventListener("abort", abort)
  }
}
