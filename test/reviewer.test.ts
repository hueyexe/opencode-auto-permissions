import { describe, expect, test } from "bun:test"
import { installReviewer } from "../src/reviewer.ts"
import type { PermissionRequest, ReviewerClient, RuntimeContext } from "../src/types.ts"

function harness(options: Record<string, unknown> = { model: "openai/gpt-5.6-luna" }) {
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
              { id: "msg_user", type: "user", time: { created: 1 }, text: "Run the tests." },
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
    generate: async () => ({ decision: "ask", reasonCode: "ambiguous", reason: "Needs review." }),
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

function request(command: string, protocol: PermissionRequest["protocol"] = "v2"): PermissionRequest {
  return {
    id: "per_1",
    sessionID: "ses_root",
    action: "shell",
    resources: [command],
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
    source: { type: "tool", messageID: "msg_assistant", callID: "call_1" },
    protocol: "v2",
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("installReviewer", () => {
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

  test("leaves an ask verdict pending", async () => {
    const app = harness()
    app.requests.push(request("git push origin feature"))
    const dispose = installReviewer(app.context, { client: app.client })

    app.emit("permission.v2.asked", app.requests[0])
    await settle()

    expect(app.replies).toEqual([])
    expect(app.requests).toHaveLength(1)
    expect(app.toasts).toEqual(["Manual approval"])
    dispose()
  })

  test("leaves a timed-out review pending for manual approval", async () => {
    const app = harness({ model: "openai/gpt-5.6-luna", timeoutMs: 100 })
    app.client.generate = ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Review aborted", "AbortError")), { once: true })
    })
    app.requests.push(request("git push origin feature"))
    const failures: unknown[] = []
    const dispose = installReviewer(app.context, {
      client: app.client,
      onFailure: (_request, error) => failures.push(error),
    })

    app.emit("permission.v2.asked", app.requests[0])
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(app.replies).toEqual([])
    expect(app.requests).toHaveLength(1)
    expect(app.toasts).toEqual(["Auto Permissions unavailable"])
    expect(failures).toHaveLength(1)
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
    const app = harness({ model: "openai/gpt-5.6-luna", shadow: true })
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
