import { describe, expect, test } from "bun:test"
import { BetaClient } from "../src/beta-client.ts"

describe("BetaClient", () => {
  test("prewarms the reviewer location without invoking a model", async () => {
    const calls: string[] = []
    const client = new BetaClient({
      app: {
        agents: async () => calls.push("agents"),
        skills: async () => calls.push("skills"),
      },
    })

    await client.prewarm()

    expect(calls).toEqual(["agents", "skills"])
  })

  test("uses an isolated deny-all reviewer session and deletes it", async () => {
    const calls: Array<{ method: string; input: any }> = []
    const client = new BetaClient({
      session: {
        async create(input: unknown) {
          calls.push({ method: "create", input })
          return { data: { id: "ses_review" } }
        },
        async prompt(input: unknown) {
          calls.push({ method: "prompt", input })
          return {
            data: {
              info: {
                role: "assistant",
                structured: { decision: "ask", reasonCode: "x", reason: "Review." },
              },
              parts: [],
            },
          }
        },
        async delete(input: unknown) {
          calls.push({ method: "delete", input })
          return { data: true }
        },
      },
    })

    const text = await client.generate({
      prompt: "review",
      model: { providerID: "example", id: "luna-5.6" },
      parentSessionID: "ses_parent",
      signal: new AbortController().signal,
    })

    expect(text).toEqual({ decision: "ask", reasonCode: "x", reason: "Review." })
    expect(calls.map((call) => call.method)).toEqual(["create", "prompt", "delete"])
    expect(calls[0]?.input).toMatchObject({
      parentID: "ses_parent",
      agent: "auto-permissions-reviewer",
      model: { providerID: "example", id: "luna-5.6" },
      permission: [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "StructuredOutput", pattern: "*", action: "allow" },
      ],
      directory: expect.stringContaining("opencode-auto-permissions"),
    })
    expect(calls[1]?.input).toMatchObject({
      agent: "auto-permissions-reviewer",
      format: {
        type: "json_schema",
        retryCount: 1,
      },
    })
  })

  test("deletes the reviewer session when generation fails", async () => {
    let deleted = false
    const client = new BetaClient({
      session: {
        create: async () => ({ data: { id: "ses_review" } }),
        prompt: async () => {
          throw new Error("provider failed")
        },
        delete: async () => {
          deleted = true
        },
      },
    })

    await expect(
      client.generate({
        prompt: "review",
        model: { providerID: "example", id: "luna-5.6" },
        parentSessionID: "ses_parent",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("provider failed")
    expect(deleted).toBeTrue()
  })

  test("treats a permission 404 as a lost race", async () => {
    const permission = {
      marker: "bound",
      async reply(this: { marker: string }) {
        expect(this.marker).toBe("bound")
        throw { status: 404 }
      },
    }
    const client = new BetaClient({
      v2: {
        session: {
          permission,
        },
      },
    })

    await expect(
      client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once" }),
    ).resolves.toBe("not_found")
  })

  test("prefers the V2 session-scoped permission endpoint", async () => {
    const calls: string[] = []
    const client = new BetaClient({
      permission: {
        reply: async () => calls.push("legacy"),
      },
      v2: {
        session: {
          permission: {
            reply: async () => calls.push("v2"),
          },
        },
      },
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once" })

    expect(calls).toEqual(["v2"])
  })
})
