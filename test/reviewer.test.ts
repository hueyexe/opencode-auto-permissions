import { describe, expect, test } from "bun:test"
import { installReviewer } from "../src/reviewer.ts"
import type { PermissionRequest, ReviewerClient, RuntimeContext } from "../src/types.ts"

function harness(options: Record<string, unknown> = { model: "example/luna-5.6" }) {
  const handlers = new Map<string, Set<(event: unknown) => void>>()
  const requests: PermissionRequest[] = []
  const replies: Parameters<ReviewerClient["reply"]>[0][] = []
  const toasts: string[] = []

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

  return { context, client, requests, replies, toasts, emit }
}

function request(command: string): PermissionRequest {
  return {
    id: "per_1",
    sessionID: "ses_root",
    action: "shell",
    resources: [command],
    source: { type: "tool", messageID: "msg_assistant", callID: "call_1" },
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

    expect(app.replies).toEqual([{ sessionID: "ses_root", requestID: "per_1", reply: "once" }])
    expect(app.toasts).toEqual([])
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
    const app = harness({ model: "example/luna-5.6", shadow: true })
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
})
