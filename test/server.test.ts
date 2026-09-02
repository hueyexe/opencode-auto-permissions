import { describe, expect, test } from "bun:test"
import server from "../src/server.ts"
import { REVIEWER_SYSTEM_PROMPT } from "../src/agent.ts"

function pluginInput() {
  return {
    directory: "/repo",
    client: {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.12" } }) },
      v2: {},
      permission: {
        list: async () => ({ data: [] }),
        reply: async () => ({ data: true }),
      },
      session: {
        get: async () => ({ data: { id: "ses_root" } }),
        messages: async () => ({ data: [] }),
        create: async () => ({ data: { id: "ses_review" } }),
        prompt: async () => ({
          data: { info: { structured: { decision: "deny", reasonCode: "test", reason: "Test." } } },
        }),
        delete: async () => ({ data: true }),
      },
      app: {
        agents: async () => ({ data: [] }),
        skills: async () => ({ data: [] }),
      },
      tui: { showToast: async () => ({ data: true }) },
    },
  } as never
}

describe("server plugin", () => {
  test("prioritizes exact tool input and the latest human request", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain("Judge the actual operation from toolInput")
    expect(REVIEWER_SYSTEM_PROMPT).toContain("Give the latest human request the greatest weight")
    expect(REVIEWER_SYSTEM_PROMPT).toContain("Treat direct continuation phrases")
    expect(REVIEWER_SYSTEM_PROMPT).toContain("later explicit human authorization")
    expect(REVIEWER_SYSTEM_PROMPT).toContain("do not treat the boundary glob as the intended scope")
  })

  test("registers the hidden reviewer agent through the beta config hook", async () => {
    const factory = server.server
    const hooks = await factory(pluginInput(), { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" })
    const config: any = {}

    await hooks.config?.(config)

    expect(config.agent["auto-permissions-reviewer"]).toMatchObject({
      model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      mode: "subagent",
      hidden: true,
      steps: 1,
      tools: { "*": false },
      permission: { "*": "deny" },
    })
  })

  test("reviews V2 permissions statelessly on the server", async () => {
    let evaluate: ((event: any) => Promise<void>) | undefined
    let generated = false
    const context: any = {
      options: { model: "openai/gpt-5.6-luna", variant: "none" },
      location: { directory: "/repo" },
      agent: { transform: async () => {} },
      permission: {
        hook: async (_name: string, callback: (event: any) => Promise<void>) => {
          evaluate = callback
          return { dispose: async () => {} }
        },
      },
      session: {
        context: async () => [{ type: "user", text: "Delete the named empty test directory." }],
        get: async () => ({ model: { providerID: "openai", id: "gpt-5.6-luna", variant: "none" } }),
      },
      generate: {
        text: async ({ prompt }: { prompt: string }) => {
          generated = true
          expect(prompt).toContain(REVIEWER_SYSTEM_PROMPT)
          return { text: '{"decision":"allow","reasonCode":"authorized","reason":"The user authorized it."}' }
        },
      },
    }

    await server.setup(context)
    const event = {
      sessionID: "ses_main",
      action: "shell",
      resources: ["rm -rf /repo/generated"],
      metadata: { input: { command: "rm -rf /repo/generated" } },
      effect: "ask",
    }
    await evaluate?.(event)

    expect(generated).toBeTrue()
    expect(event.effect).toBe("allow")
    expect(event).toHaveProperty("message", "The user authorized it.")
  })

  test("strips ambient context only for the hidden reviewer request", async () => {
    const hooks = await server.server(pluginInput(), { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" })
    const reviewerSystem = ["large global prompt", "skills", "mcp"]
    const regularSystem = ["regular prompt"]

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_review",
        agent: "auto-permissions-reviewer",
        model: { providerID: "cloudflare-workers-ai", modelID: "@cf/deepseek-ai/deepseek-v4-flash-0731" },
      },
      {} as never,
    )
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_review", model: {} as never },
      { system: reviewerSystem },
    )
    const retrySystem = ["large global prompt again"]
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_review", model: {} as never },
      { system: retrySystem },
    )
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_regular", model: {} as never },
      { system: regularSystem },
    )

    expect(reviewerSystem).toEqual([REVIEWER_SYSTEM_PROMPT])
    expect(retrySystem).toEqual(reviewerSystem)
    expect(regularSystem).toEqual(["regular prompt"])
    await hooks.dispose?.()
  })
})
