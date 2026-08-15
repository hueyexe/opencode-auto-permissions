import { describe, expect, test } from "bun:test"
import plugin from "../src/tui.ts"
import type { RuntimeContext } from "../src/types.ts"

function context(version: string): { context: RuntimeContext; subscriptions: string[] } {
  const subscriptions: string[] = []
  return {
    context: {
      options: { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" },
      client: {
        global: { health: async () => ({ data: { healthy: true, version } }) },
      },
      data: {
        on(type) {
          subscriptions.push(type)
          return () => {}
        },
        session: {
          root: (id) => id,
          get: (id) => ({ id }),
          message: { list: () => [], get: () => undefined, sync: async () => {} },
          permission: { list: () => [], sync: async () => {} },
        },
      },
    },
    subscriptions,
  }
}

describe("TUI plugin runtime ownership", () => {
  test("does not subscribe to permission events on stable OpenCode", async () => {
    const app = context("1.18.12")

    expect(await plugin.setup(app.context)).toBeUndefined()
    expect(app.subscriptions).toEqual([])
  })

  test("owns V2 permission events on beta OpenCode", async () => {
    const app = context("0.0.0-beta-202608040144")

    const dispose = await plugin.setup(app.context)

    expect(app.subscriptions).toEqual([
      "permission.v2.replied",
      "permission.replied",
      "permission.v2.asked",
      "permission.asked",
    ])
    expect(typeof dispose).toBe("function")
    dispose?.()
  })
})
