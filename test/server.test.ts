import { describe, expect, test } from "bun:test"
import server from "../src/server.ts"

describe("server plugin", () => {
  test("registers the hidden reviewer agent through the beta config hook", async () => {
    const factory = server.server
    const hooks = await factory({} as never, { model: "kiro/gpt-5.6-luna" })
    const config: any = {}

    await hooks.config?.(config)

    expect(config.agent["auto-permissions-reviewer"]).toMatchObject({
      model: "kiro/gpt-5.6-luna",
      mode: "subagent",
      hidden: true,
      steps: 1,
      tools: { "*": false },
      permission: { "*": "deny" },
    })
  })

  test("strips ambient context only for the hidden reviewer request", async () => {
    const hooks = await server.server({} as never, { model: "kiro/gpt-5.6-luna" })
    const reviewerSystem = ["large global prompt", "skills", "mcp"]
    const regularSystem = ["regular prompt"]

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_review",
        agent: "auto-permissions-reviewer",
        model: { providerID: "kiro", modelID: "gpt-5.6-luna" },
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

    expect(reviewerSystem).toHaveLength(1)
    expect(reviewerSystem[0]).toContain("automatic permission reviewer")
    expect(retrySystem).toEqual(reviewerSystem)
    expect(regularSystem).toEqual(["regular prompt"])
    await hooks.dispose?.()
  })
})
