import { OpenCodeClientAdapter } from "./opencode-client.ts"
import { parseConfig, type Config } from "./config.ts"
import {
  collectReviewInput,
  isRequestPending,
  normalizeAskedEvent,
  normalizeRepliedEvent,
} from "./context.ts"
import { applyDeterministicPolicy } from "./policy.ts"
import { buildReviewPrompt } from "./prompt.ts"
import type {
  Decision,
  PermissionProtocol,
  PermissionRequest,
  ReviewerClient,
  RuntimeContext,
} from "./types.ts"
import { parseDecision } from "./verdict.ts"
import { failureCategory, writeDiagnostic } from "./diagnostics.ts"

export interface ReviewerOverrides {
  client?: ReviewerClient
  protocols?: PermissionProtocol[]
  onDecision?(request: PermissionRequest, decision: Decision, shadow: boolean): void
  onFailure?(request: PermissionRequest, error: unknown): void
}

export function installReviewer(context: RuntimeContext, overrides: ReviewerOverrides = {}): () => void {
  const config = parseConfig(context.options)
  const client = overrides.client ?? new OpenCodeClientAdapter(context.client)
  const inFlight = new Map<string, AbortController>()
  const configuredProtocols: PermissionProtocol[] = overrides.protocols ?? ["stable", "v2"]
  const protocols = new Set(configuredProtocols)
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    event: "plugin_started",
  })
  void client.prewarm?.().catch(() => undefined)

  const offReplied = context.data.on("permission.v2.replied", (event) => {
    const reply = normalizeRepliedEvent(event)
    if (reply) cancelReview(config, inFlight, reply.requestID)
  })
  const offStableReplied = context.data.on("permission.replied", (event) => {
    const reply = normalizeRepliedEvent(event)
    if (reply) cancelReview(config, inFlight, reply.requestID)
  })

  const offAsked = context.data.on("permission.v2.asked", (event) => {
    const asked = normalizeAskedEvent(event)
    if (!asked || !protocols.has(asked.protocol) || inFlight.has(asked.id))
      return

    const controller = new AbortController()
    const startedAt = performance.now()
    writeReceived(config, asked)
    inFlight.set(asked.id, controller)
    void reviewAndReply(context, client, config, asked, controller.signal, overrides, startedAt)
      .catch((error) => {
        if (controller.signal.aborted) return
        writeFailure(config, asked, startedAt, error)
        overrides.onFailure?.(asked, error)
        context.showToast?.({
          title: "Auto Permissions unavailable",
          message: "Manual approval required.",
          variant: "warning",
          duration: 4_000,
        })
      })
      .finally(() => {
        if (inFlight.get(asked.id) === controller) inFlight.delete(asked.id)
      })
  })
  const offStableAsked = context.data.on("permission.asked", (event) => {
    const normalized = normalizeAskedEvent(event)
    const asked = normalized && configuredProtocols.length === 1
      ? { ...normalized, protocol: configuredProtocols[0]! }
      : normalized
    if (!asked || !protocols.has(asked.protocol) || inFlight.has(asked.id))
      return
    const controller = new AbortController()
    const startedAt = performance.now()
    writeReceived(config, asked)
    inFlight.set(asked.id, controller)
    void reviewAndReply(context, client, config, asked, controller.signal, overrides, startedAt)
      .catch((error) => {
        if (controller.signal.aborted) return
        writeFailure(config, asked, startedAt, error)
        overrides.onFailure?.(asked, error)
        context.showToast?.({
          title: "Auto Permissions unavailable",
          message: "Manual approval required.",
          variant: "warning",
          duration: 4_000,
        })
      })
      .finally(() => {
        if (inFlight.get(asked.id) === controller) inFlight.delete(asked.id)
      })
  })

  return () => {
    offAsked()
    offStableAsked()
    offReplied()
    offStableReplied()
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
  startedAt: number,
): Promise<void> {
  const input = await collectReviewInput(context, request, config.userMessageCount)
  if (parentSignal.aborted) return

  const policyDecision = applyDeterministicPolicy(input)
  const decision = policyDecision ?? (await modelDecision(context, client, config, input, parentSignal))
  if (parentSignal.aborted) return

  overrides.onDecision?.(request, decision, config.shadow)
  if (config.shadow) {
    writeDecision(config, request, startedAt, decision, policyDecision ? "policy" : "model")
    return
  }

  if (decision.kind === "ask") {
    context.showToast?.({
      title: "Manual approval",
      message: decision.reason,
      variant: "info",
      duration: 4_000,
    })
    writeDecision(config, request, startedAt, decision, policyDecision ? "policy" : "model", "manual")
    return
  }

  const pending = await isRequestPending(context, request)
  if (!pending || parentSignal.aborted) return

  if (decision.kind === "allow") {
    const result = await client.reply({
      sessionID: request.sessionID,
      requestID: request.id,
      reply: "once",
      protocol: request.protocol,
    })
    writeDecision(config, request, startedAt, decision, policyDecision ? "policy" : "model", result)
    return
  }

  const result = await client.reply({
    sessionID: request.sessionID,
    requestID: request.id,
    reply: "reject",
    message: `Auto Permissions blocked this action: ${decision.reason}`,
    protocol: request.protocol,
  })
  context.showToast?.({ title: "Blocked", message: decision.reason, variant: "warning", duration: 4_000 })
  writeDecision(config, request, startedAt, decision, policyDecision ? "policy" : "model", result)
  if (result === "replied") context.resumeAfterDenial?.(request.sessionID, decision.reason)
}

function writeDecision(
  config: Config,
  request: PermissionRequest,
  startedAt: number,
  decision: Decision,
  source: "policy" | "model",
  replyResult?: "replied" | "not_found" | "manual",
): void {
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    requestID: request.id,
    sessionID: request.sessionID,
    protocol: request.protocol,
    action: request.action,
    resourceCount: request.resources.length,
    elapsedMs: Math.round(performance.now() - startedAt),
    event: "decision",
    source,
    decision: decision.kind,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    shadow: config.shadow,
    ...(replyResult ? { replyResult } : {}),
  })
}

function writeFailure(config: Config, request: PermissionRequest, startedAt: number, error: unknown): void {
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    requestID: request.id,
    sessionID: request.sessionID,
    protocol: request.protocol,
    action: request.action,
    resourceCount: request.resources.length,
    elapsedMs: Math.round(performance.now() - startedAt),
    event: "failure",
    failureCategory: failureCategory(error),
    errorName: error instanceof Error ? error.name : "Error",
    errorMessage: error instanceof Error ? error.message : String(error),
  })
}

function writeReceived(config: Config, request: PermissionRequest): void {
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    event: "request_received",
    requestID: request.id,
    sessionID: request.sessionID,
    protocol: request.protocol,
    action: request.action,
    resourceCount: request.resources.length,
  })
}

function cancelReview(config: Config, inFlight: Map<string, AbortController>, requestID: string): void {
  const controller = inFlight.get(requestID)
  if (!controller || controller.signal.aborted) return
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    event: "request_cancelled",
    requestID,
  })
  controller.abort("permission resolved")
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
