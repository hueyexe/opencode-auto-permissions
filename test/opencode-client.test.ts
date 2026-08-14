import { describe, expect, test } from "bun:test"
import { OpenCodeClientAdapter } from "../src/opencode-client.ts"

describe("OpenCodeClientAdapter", () => {
  test("prewarms the reviewer location without invoking a model", async () => {
    const calls: string[] = []
    const client = new OpenCodeClientAdapter({
      app: {
        agents: async () => calls.push("agents"),
        skills: async () => calls.push("skills"),
      },
    })

    await client.prewarm()

    expect(calls).toEqual(["agents", "skills"])
  })

  test("deletes stale standalone reviewer sessions during prewarm", async () => {
    const deleted: unknown[] = []
    const client = new OpenCodeClientAdapter({
      app: {
        agents: async () => undefined,
        skills: async () => undefined,
      },
      v2: {
        session: {
          list: async () => ({
            data: {
              data: [
                { id: "ses_review", title: "Auto Permissions review" },
                { id: "ses_user", title: "User session" },
              ],
            },
          }),
          delete: async (input: unknown) => deleted.push(input),
        },
      },
    })

    await client.prewarm()

    expect(deleted).toEqual([{
      sessionID: "ses_review",
      directory: expect.stringContaining("opencode-auto-permissions"),
    }])
  })

  test("uses an isolated deny-all reviewer session and deletes it", async () => {
    const calls: Array<{ method: string; input: any }> = []
    const client = new OpenCodeClientAdapter({
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
                structured: { decision: "deny", reasonCode: "x", reason: "Review." },
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

    expect(text).toEqual({ decision: "deny", reasonCode: "x", reason: "Review." })
    expect(calls.map((call) => call.method)).toEqual(["create", "prompt", "delete"])
    expect(calls[0]?.input).toMatchObject({
      agent: "auto-permissions-reviewer",
      model: { providerID: "example", id: "luna-5.6" },
      permission: [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "StructuredOutput", pattern: "*", action: "allow" },
      ],
      directory: expect.stringContaining("opencode-auto-permissions"),
    })
    expect(calls[0]?.input).not.toHaveProperty("parentID")
    expect(calls[1]?.input).toMatchObject({
      agent: "auto-permissions-reviewer",
      format: {
        type: "json_schema",
        retryCount: 1,
      },
    })
  })

  test("prefers the V2 subclient for structured reviewer sessions when available", async () => {
    const calls: string[] = []
    const client = new OpenCodeClientAdapter({
      session: {
        create: async () => {
          calls.push("legacy")
          return { data: { id: "ses_legacy" } }
        },
        prompt: async () => ({ data: {} }),
      },
      v2: {
        session: {
          create: async () => {
            calls.push("v2-create")
            return { data: { id: "ses_review" } }
          },
          prompt: async () => {
            calls.push("v2-prompt")
            return { data: { info: { structured: { decision: "deny", reasonCode: "x", reason: "Review." } } } }
          },
          delete: async () => calls.push("v2-delete"),
        },
      },
    })

    await client.generate({
      prompt: "review",
      model: { providerID: "example", id: "luna-5.6" },
      parentSessionID: "ses_parent",
      signal: new AbortController().signal,
    })

    expect(calls).toEqual(["v2-create", "v2-prompt", "v2-delete"])
  })

  test("deletes the reviewer session when generation fails", async () => {
    let deleted = false
    const client = new OpenCodeClientAdapter({
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

  test("falls back to strict JSON text when structured output is unavailable", async () => {
    const prompts: any[] = []
    const client = new OpenCodeClientAdapter({
      session: {
        create: async () => ({ data: { id: "ses_review" } }),
        prompt: async (input: any) => {
          prompts.push(input)
          if (prompts.length === 1) {
            return {
              data: {
                info: {
                  error: { name: "StructuredOutputError", data: { message: "No structured output", retries: 1 } },
                },
                parts: [],
              },
            }
          }
          return {
            data: {
              info: { role: "assistant" },
              parts: [{
                type: "text",
                text: '{"decision":"allow","reasonCode":"authorized","reason":"Requested by the user."}',
              }],
            },
          }
        },
        delete: async () => ({ data: true }),
      },
    })

    await expect(client.generate({
      prompt: "review",
      model: { providerID: "example", id: "luna-5.6" },
      parentSessionID: "ses_parent",
      signal: new AbortController().signal,
    })).resolves.toEqual({
      decision: "allow",
      reasonCode: "authorized",
      reason: "Requested by the user.",
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatchObject({ format: { type: "text" } })
    expect(prompts[1].parts[0].text).toContain('exactly these three keys')
    expect(prompts[1].parts[0].text).toContain('"decision": one of "allow", "allow_session", or "deny"')
  })

  test("uses the generated stable abort envelope when review is cancelled", async () => {
    const calls: unknown[] = []
    const controller = new AbortController()
    const client = new OpenCodeClientAdapter({
      postSessionIdPermissionsPermissionId: async () => {},
      session: {
        create: async () => ({ data: { id: "ses_review" } }),
        prompt: async () => {
          controller.abort("permission resolved")
          throw new DOMException("permission resolved", "AbortError")
        },
        abort: async (input: unknown) => calls.push(input),
        delete: async () => ({ data: true }),
      },
    })

    await expect(
      client.generate({
        prompt: "review",
        model: { providerID: "openai", id: "gpt-5.6-luna" },
        parentSessionID: "ses_parent",
        signal: controller.signal,
      }),
    ).rejects.toThrow("permission resolved")
    await Promise.resolve()

    expect(calls).toEqual([
      {
        path: { id: "ses_review" },
        query: { directory: expect.stringContaining("opencode-auto-permissions") },
      },
    ])
  })

  test("treats a permission 404 as a lost race", async () => {
    const permission = {
      marker: "bound",
      async reply(this: { marker: string }) {
        expect(this.marker).toBe("bound")
        throw { status: 404 }
      },
    }
    const client = new OpenCodeClientAdapter({
      v2: {
        session: {
          permission,
        },
      },
    })

    await expect(
      client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once", protocol: "v2" }),
    ).resolves.toBe("not_found")
  })

  test("prefers the V2 session-scoped permission endpoint", async () => {
    const calls: string[] = []
    const client = new OpenCodeClientAdapter({
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

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once", protocol: "v2" })

    expect(calls).toEqual(["v2"])
  })

  test("sends session approval through the V2 endpoint", async () => {
    const replies: unknown[] = []
    const client = new OpenCodeClientAdapter({
      v2: {
        session: {
          permission: {
            reply: async (input: unknown) => replies.push(input),
          },
        },
      },
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "always", protocol: "v2" })

    expect(replies).toEqual([{ sessionID: "ses_1", requestID: "per_1", reply: "always", protocol: "v2" }])
  })

  test("uses the direct V2 TUI session permission endpoint", async () => {
    const calls: string[] = []
    const client = new OpenCodeClientAdapter({
      session: {
        permission: {
          reply: async () => calls.push("v2-tui"),
        },
      },
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once", protocol: "v2" })

    expect(calls).toEqual(["v2-tui"])
  })

  test("falls back for transitional V2 requests in the legacy permission queue", async () => {
    const calls: string[] = []
    const client = new OpenCodeClientAdapter({
      permission: {
        reply: async () => calls.push("legacy"),
      },
      v2: {
        session: {
          permission: {
            reply: async () => ({ error: { _tag: "PermissionNotFoundError" } }),
          },
        },
      },
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once", protocol: "v2" })

    expect(calls).toEqual(["legacy"])
  })

  test("uses the stable permission endpoint for stable events", async () => {
    const calls: string[] = []
    const client = new OpenCodeClientAdapter({
      permission: {
        reply: async () => calls.push("stable"),
      },
      v2: {
        session: {
          permission: {
            reply: async () => calls.push("v2"),
          },
        },
      },
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once", protocol: "stable" })

    expect(calls).toEqual(["stable"])
  })

  test("sends session approval through the generated stable endpoint", async () => {
    const replies: unknown[] = []
    const client = new OpenCodeClientAdapter({
      postSessionIdPermissionsPermissionId: async (input: unknown) => replies.push(input),
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "always", protocol: "stable" })

    expect(replies).toEqual([{ path: { id: "ses_1", permissionID: "per_1" }, body: { response: "always" } }])
  })

  test("uses the generated stable permission endpoint", async () => {
    const calls: unknown[] = []
    const client = new OpenCodeClientAdapter({
      postSessionIdPermissionsPermissionId: async (input: unknown) => calls.push(input),
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once", protocol: "stable" })

    expect(calls).toEqual([{ path: { id: "ses_1", permissionID: "per_1" }, body: { response: "once" } }])
  })
})
