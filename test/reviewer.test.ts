import { describe, expect, test } from "bun:test"
import { installReviewer } from "../src/reviewer.ts"
import type { PermissionRequest, ReviewerClient, RuntimeContext } from "../src/types.ts"

function harness(options: Record<string, unknown> = { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" }) {
  const handlers = new Map<string, Set<(event: unknown) => void>>()
  const requests: PermissionRequest[] = []
  const replies: Parameters<ReviewerClient["reply"]>[0][] = []
  const toasts: string[] = []
  const resumptions: Array<{ sessionID: string; reason: string }> = []

  const context: RuntimeContext = {
    options,
    client: {},
    data: {
      on(type, handler) {
        const set = handlers.get(type) ?? new Set()
        set.add(handler)
        handlers.set(type, set)
        return () => set.delete(handler)
      },
      session: {
        root: () => "ses_root",
        get: (id) => ({ id }),
        message: {
          list: () => {
            const command = requests[0]?.resources[0] ?? "pnpm test"
            return [
              {
                id: "msg_user",
                type: "user",
                role: "user",
                time: { created: 1 },
                text: "Run the tests.",
                model: { providerID: "example", modelID: "main" },
              },
              {
                id: "msg_assistant",
                type: "assistant",
                time: { created: 2 },
                agent: "build",
                model: { providerID: "example", id: "main" },
                content: [
                  {
                    id: "call_1",
                    type: "tool",
                    name: "shell",
                    state: { status: "running", input: { command }, structured: {}, content: [] },
                    time: { created: 2 },
                  },
                ],
              },
            ] as never
          },
          get: (_sessionID, messageID) => {
            const command = requests[0]?.resources[0] ?? "pnpm test"
            return messageID === "msg_assistant"
              ? ({
                  id: "msg_assistant",
                  type: "assistant",
                  time: { created: 2 },
                  agent: "build",
                  model: { providerID: "example", id: "main" },
                  content: [
                    {
                      id: "call_1",
                      type: "tool",
                      name: "shell",
                      state: { status: "running", input: { command }, structured: {}, content: [] },
                      time: { created: 2 },
                    },
                  ],
                } as never)
              : undefined
          },
          sync: async () => {},
        },
        permission: {
          list: () => requests,
          sync: async () => {},
        },
      },
      location: { default: () => ({ directory: "/repo" }) },
    },
    showToast: (input) => toasts.push(input.title ?? input.message),
    resumeAfterDenial: (sessionID, reason) => resumptions.push({ sessionID, reason }),
  }

  const client: ReviewerClient = {
    generate: async () => ({
      decision: "deny",
      reasonCode: "missing_authorization",
      reason: "Authorization is missing; continue with a safer alternative.",
    }),
    async reply(input) {
      replies.push(input)
      const index = requests.findIndex((request) => request.id === input.requestID)
      if (index >= 0) requests.splice(index, 1)
      return "replied"
    },
  }

  const emit = (type: string, data: unknown) => {
    for (const handler of handlers.get(type) ?? []) handler({ type, data })
  }

  return { context, client, requests, replies, toasts, resumptions, emit }
}

function request(command: string, protocol: PermissionRequest["protocol"] = "v2", id = "per_1"): PermissionRequest {
  return {
    id,
    sessionID: "ses_root",
    action: "shell",
    resources: [command],
    always: [command],
    source: { type: "tool", messageID: "msg_assistant", callID: "call_1" },
    protocol,
  }
}

function toolRequest(action: string, resource: string): PermissionRequest {
  return {
    id: "per_1",
    sessionID: "ses_root",
    action,
    resources: [resource],
    always: [resource],
    source: { type: "tool", messageID: "msg_assistant", callID: "call_1" },
    protocol: "v2",
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("installReviewer", () => {
  test("uses the requesting session model when no reviewer model is configured", async () => {
    const app = harness({})
    let model: Parameters<ReviewerClient["generate"]>[0]["model"] | undefined
    app.client.generate = async (input) => {
      model = input.model
      return { decision: "allow", reasonCode: "requested_action", reason: "The user requested this action." }
    }
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(model).toEqual({ providerID: "example", id: "main" })
    expect(app.replies).toHaveLength(1)
    dispose()
  })

  test("silently approves a deterministic safe command once", async () => {
    const app = harness()
    app.requests.push(request("pnpm test"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies).toEqual([
      { sessionID: "ses_root", requestID: "per_1", reply: "once", protocol: "v2" },
    ])
    expect(app.toasts).toEqual([])
    dispose()
  })

  test("reviews permission actions outside shell and external directory", async () => {
    const app = harness()
    app.client.generate = async () => ({ decision: "allow", reasonCode: "requested_read", reason: "Reads a project file." })
    app.requests.push(toolRequest("read", "src/index.ts"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies).toEqual([
      { sessionID: "ses_root", requestID: "per_1", reply: "once", protocol: "v2" },
    ])
    dispose()
  })

  test("allows a narrow repeatable action for the remainder of the session", async () => {
    const app = harness()
    app.client.generate = async () => ({
      decision: "allow_session",
      reasonCode: "repeatable_fetch",
      reason: "Fetching this remote is a repeatable low-risk operation.",
    })
    const pending = request("git fetch origin")
    pending.always = ["git fetch origin*"]
    app.requests.push(pending)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies).toEqual([
      { sessionID: "ses_root", requestID: "per_1", reply: "always", protocol: "v2" },
    ])
    dispose()
  })

  test("reuses an approved narrow pattern without another model call", async () => {
    const app = harness()
    let reviews = 0
    app.client.generate = async () => {
      reviews++
      return { decision: "allow", reasonCode: "approved_fetch", reason: "The fetch is approved." }
    }
    const first = request("git fetch origin", "v2", "per_1")
    first.always = ["git fetch origin*"]
    app.requests.push(first)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", first)
    await settle()
    const second = request("git fetch origin main", "v2", "per_2")
    second.always = ["git fetch origin*"]
    app.requests.push(second)
    app.emit("permission.v2.asked", second)
    await settle()

    expect(reviews).toBe(1)
    expect(app.replies.map((reply) => reply.requestID)).toEqual(["per_1", "per_2"])
    dispose()
  })

  test("coalesces concurrent identical requests into one model review", async () => {
    const app = harness()
    let reviews = 0
    let release!: () => void
    app.client.generate = async () => {
      reviews++
      await new Promise<void>((resolve) => { release = resolve })
      return { decision: "allow", reasonCode: "approved_push", reason: "The push is approved." }
    }
    const first = request("git push origin main", "v2", "per_1")
    const second = request("git push origin main", "v2", "per_2")
    app.requests.push(first, second)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", first)
    app.emit("permission.v2.asked", second)
    for (let attempt = 0; attempt < 20 && !release; attempt++) await Promise.resolve()
    release()
    await settle()

    expect(reviews).toBe(1)
    expect(app.replies.map((reply) => reply.requestID).sort()).toEqual(["per_1", "per_2"])
    expect(app.replies.every((reply) => reply.reply === "once")).toBeTrue()
    dispose()
  })

  test.each([
    { command: "git push origin feature", always: ["git push origin feature"] },
    { command: "git fetch origin", always: ["*"] },
    { command: "git fetch origin", always: ["git *"] },
  ])("downgrades ineligible session approval for $command", async ({ command, always }) => {
    const app = harness()
    app.client.generate = async () => ({
      decision: "allow_session",
      reasonCode: "repeatable_action",
      reason: "Allow matching actions for this session.",
    })
    const pending = request(command)
    pending.always = [...always]
    app.requests.push(pending)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies[0]?.reply).toBe("once")
    dispose()
  })

  test("can disable session approvals", async () => {
    const app = harness({ model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", sessionApprovals: false })
    app.client.generate = async () => ({
      decision: "allow_session",
      reasonCode: "repeatable_fetch",
      reason: "Fetching this remote is a repeatable low-risk operation.",
    })
    const pending = request("git fetch origin")
    pending.always = ["git fetch origin*"]
    app.requests.push(pending)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies[0]?.reply).toBe("once")
    dispose()
  })

  test.each([
    { action: "read", resource: "/home/user/.ssh/id_ed25519" },
    { action: "shell", resource: "cat /repo/.env" },
  ])("keeps credential-sensitive $action approval one-time", async ({ action, resource }) => {
    const app = harness()
    app.client.generate = async () => ({
      decision: "allow_session",
      reasonCode: "repeatable_access",
      reason: "Allow matching access for this session.",
    })
    const pending = action === "shell" ? request(resource) : toolRequest(action, resource)
    pending.always = [resource]
    app.requests.push(pending)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies[0]?.reply).toBe("once")
    dispose()
  })

  test("automatically rejects a deterministic unsafe command with feedback", async () => {
    const app = harness()
    app.requests.push(request("sudo rm -rf /"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies[0]).toMatchObject({ reply: "reject", message: expect.stringContaining("blocked") })
    expect(app.toasts).toEqual(["Blocked"])
    expect(app.resumptions).toEqual([
      {
        sessionID: "ses_root",
        reason: "Recursively deleting the filesystem root or home directory would cause catastrophic data loss; target only the specific generated directory instead.",
      },
    ])
    dispose()
  })

  test("resolves a deny verdict with helpful continuation", async () => {
    const app = harness()
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies[0]).toMatchObject({ reply: "reject", message: expect.stringContaining("safer alternative") })
    expect(app.requests).toHaveLength(0)
    expect(app.toasts).toEqual(["Blocked"])
    expect(app.resumptions).toEqual([
      { sessionID: "ses_root", reason: "Authorization is missing; continue with a safer alternative." },
    ])
    dispose()
  })

  test("rejects a timed-out review and resumes with safer guidance", async () => {
    const app = harness({ model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", timeoutMs: 100 })
    app.client.generate = ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Review timed out")), { once: true })
    })
    app.requests.push(request("git push origin feature"))
    const failures: unknown[] = []
    const dispose = installReviewer(app.context, {
      client: app.client,
      onFailure: (_request, error) => failures.push(error),
    })

    app.emit("permission.v2.asked", app.requests[0])
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(app.replies[0]).toMatchObject({ reply: "reject", message: expect.stringContaining("timed out") })
    expect(app.requests).toHaveLength(0)
    expect(app.toasts).toEqual(["Blocked"])
    expect(app.resumptions[0]?.reason).toContain("narrower or lower-risk step")
    expect(failures).toHaveLength(1)
    dispose()
  })

  test("rejects a provider failure and resumes with safer guidance", async () => {
    const app = harness()
    app.client.generate = async () => { throw new Error("provider unavailable") }
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies[0]).toMatchObject({ reply: "reject", message: expect.stringContaining("review failed") })
    expect(app.requests).toHaveLength(0)
    expect(app.resumptions[0]?.reason).toContain("narrower or lower-risk step")
    dispose()
  })

  test("reports an aborted generation as a timeout when its deadline expires", async () => {
    const app = harness({ model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", timeoutMs: 100 })
    app.client.generate = async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true })
      })
      throw new Error("unreachable")
    }
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(app.replies[0]?.message).toContain("review timed out")
    expect(app.resumptions[0]?.reason).toContain("timed out")
    dispose()
  })

  test("cancels a review when another actor replies first", async () => {
    const app = harness()
    app.requests.push(request("git push origin feature"))
    let release!: (value: string) => void
    app.client.generate = () => new Promise((resolve) => (release = resolve))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    for (let attempt = 0; attempt < 20 && !release; attempt++) await Promise.resolve()
    expect(typeof release).toBe("function")
    app.requests.length = 0
    app.emit("permission.v2.replied", { sessionID: "ses_root", requestID: "per_1", reply: "reject" })
    release({ decision: "allow", reasonCode: "approved", reason: "Allowed." } as never)
    await settle()

    expect(app.replies).toEqual([])
    dispose()
  })

  test("shadow mode records but never replies", async () => {
    const app = harness({ model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", shadow: true })
    app.requests.push(request("pnpm test"))
    const decisions: string[] = []
    const dispose = installReviewer(app.context, {
      client: app.client,
      onDecision: (_request, decision) => decisions.push(decision.kind),
    })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(decisions).toEqual(["allow"])
    expect(app.replies).toEqual([])
    dispose()
  })

  test("auto-detects the stable permission event protocol", async () => {
    const app = harness()
    const stable = request("git status", "stable")
    app.requests.push(stable)
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.asked", {
      id: stable.id,
      sessionID: stable.sessionID,
      permission: "bash",
      patterns: stable.resources,
      metadata: {},
      always: [],
      tool: { messageID: "msg_assistant", callID: "call_1" },
    })
    await settle()

    expect(app.replies).toEqual([
      { sessionID: "ses_root", requestID: "per_1", reply: "once", protocol: "stable" },
    ])
    dispose()
  })

  test("claims transitional permission.asked events for a V2-only owner", async () => {
    const app = harness()
    const pending = request("git status")
    app.requests.push(pending)
    const dispose = installReviewer(app.context, { client: app.client, protocols: ["v2"] })

    app.emit("permission.asked", {
      id: pending.id,
      sessionID: pending.sessionID,
      permission: "bash",
      patterns: pending.resources,
      metadata: {},
      always: [],
      tool: { messageID: "msg_assistant", callID: "call_1" },
    })
    await settle()

    expect(app.replies).toEqual([
      { sessionID: "ses_root", requestID: "per_1", reply: "once", protocol: "v2" },
    ])
    dispose()
  })
})
