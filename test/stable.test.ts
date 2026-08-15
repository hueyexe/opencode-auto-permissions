import { describe, expect, test } from "bun:test"
import { createStableRuntime, protocolForVersion } from "../src/stable.ts"

function client() {
  const prompts: unknown[] = []
  let statusChecks = 0
  const sessions = new Map([
    ["ses_child", { id: "ses_child", parentID: "ses_root" }],
    ["ses_root", { id: "ses_root" }],
  ])
  const pending = [
    {
      id: "per_1",
      sessionID: "ses_child",
      permission: "bash",
      patterns: ["git status"],
      metadata: {},
      always: [],
      tool: { messageID: "msg_assistant", callID: "call_1" },
    },
  ]
  return {
    global: { health: async () => ({ data: { healthy: true, version: "1.18.12" } }) },
    v2: {},
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: sessions.get(path.id) }),
      messages: async ({ path }: { path: { id: string } }) => ({
        data: [
          {
            info: {
              id: "msg_user",
              role: "user",
              agent: "build",
              model: { providerID: "cloudflare-workers-ai", modelID: "@cf/deepseek-ai/deepseek-v4-flash-0731", variant: "max" },
            },
            parts: [{ type: "text", text: "Inspect the repository." }],
          },
          {
            info: { id: "msg_assistant", role: "assistant" },
            parts: [{ type: "tool", callID: "call_1", state: { input: { command: "git status" } } }],
          },
        ],
      }),
      promptAsync: async (input: unknown) => {
        prompts.push(input)
        return { data: undefined }
      },
      status: async () => ({
        data: statusChecks++ === 0 ? { ses_child: { type: "busy" } } : { ses_child: { type: "idle" } },
      }),
    },
    permission: {
      list: async () => ({ data: pending }),
      reply: async () => ({ data: true }),
    },
    tui: { showToast: async () => ({ data: true }) },
    prompts,
  }
}

describe("createStableRuntime", () => {
  test("detects stable and V2 runtime versions", () => {
    expect(protocolForVersion("1.18.12")).toBe("stable")
    expect(protocolForVersion("0.0.0-beta-202608040144")).toBe("v2")
    expect(protocolForVersion("2.0.0")).toBe("v2")
    expect(protocolForVersion(undefined)).toBeUndefined()
  })

  test("does not permanently classify an unavailable version", async () => {
    const runtime = createStableRuntime(
      { ...client(), global: {} },
      { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" },
      "/repo",
    )

    expect(await runtime.version()).toBeUndefined()
    runtime.dispose()
  })

  test("resumes the session with safe continuation guidance after a denial", async () => {
    const injected = client()
    const runtime = createStableRuntime(injected, { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" }, "/repo")
    await runtime.context.data.session.message.sync("ses_child")

    runtime.context.resumeAfterDenial?.("ses_child", "The user explicitly prohibited this action.")
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(injected.prompts).toEqual([
      {
        path: { id: "ses_child" },
        query: { directory: "/repo" },
        body: {
          agent: "build",
          model: { providerID: "cloudflare-workers-ai", modelID: "@cf/deepseek-ai/deepseek-v4-flash-0731" },
          variant: "max",
          parts: [{
            type: "text",
            text: expect.stringContaining("Continue the task using a safer alternative"),
          }],
        },
      },
    ])
    runtime.dispose()
  })

  test("normalizes legacy permission.updated events and resolves root context", async () => {
    const runtime = createStableRuntime(client(), { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" }, "/repo")
    const seen: unknown[] = []
    runtime.context.data.on("permission.asked", (event) => seen.push(event))

    runtime.emit({
      type: "permission.updated",
      properties: {
        id: "per_1",
        type: "bash",
        pattern: "git status",
        sessionID: "ses_child",
        messageID: "msg_assistant",
        callID: "call_1",
        title: "Run command",
        metadata: {},
      },
    })

    expect(seen).toHaveLength(1)
    expect(await runtime.context.data.session.root("ses_child")).toBe("ses_root")
    await runtime.context.data.session.message.sync("ses_root")
    expect(runtime.context.data.session.message.list("ses_root")).toHaveLength(2)
    await runtime.context.data.session.permission.sync("ses_child")
    expect(runtime.context.data.session.permission.list("ses_child")).toMatchObject([
      { id: "per_1", action: "bash", resources: ["git status"], always: [], protocol: "stable" },
    ])
    runtime.dispose()
  })

  test("normalizes stable permission replies", () => {
    const runtime = createStableRuntime(client(), { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" }, "/repo")
    const seen: unknown[] = []
    runtime.context.data.on("permission.replied", (event) => seen.push(event))

    runtime.emit({
      type: "permission.replied",
      properties: { sessionID: "ses_child", permissionID: "per_1", response: "once" },
    })

    expect(seen).toHaveLength(1)
    runtime.dispose()
  })
})
