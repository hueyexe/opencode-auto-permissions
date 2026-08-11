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
          data: { info: { structured: { decision: "ask", reasonCode: "test", reason: "Test." } } },
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
    expect(REVIEWER_SYSTEM_PROMPT).toContain("do not treat the boundary glob as the intended scope")
  })

  test("registers the hidden reviewer agent through the beta config hook", async () => {
    const factory = server.server
    const hooks = await factory(pluginInput(), { model: "openai/gpt-5.6-luna" })
    const config: any = {}

    await hooks.config?.(config)

    expect(config.agent["auto-permissions-reviewer"]).toMatchObject({
      model: "openai/gpt-5.6-luna",
      mode: "subagent",
      hidden: true,
      steps: 1,
      tools: { "*": false },
      permission: { "*": "deny" },
    })
  })

  test("strips ambient context only for the hidden reviewer request", async () => {
    const hooks = await server.server(pluginInput(), { model: "openai/gpt-5.6-luna" })
    const reviewerSystem = ["large global prompt", "skills", "mcp"]
    const regularSystem = ["regular prompt"]

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_review",
        agent: "auto-permissions-reviewer",
        model: { providerID: "kiro-openai", modelID: "gpt-5.6-luna" },
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
