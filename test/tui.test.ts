import { describe, expect, test } from "bun:test"
import plugin from "../src/tui.ts"
import type { Context } from "@opencode-ai/plugin/tui/plugin"

function context(version: string): { context: Context; subscriptions: string[] } {
  const subscriptions: string[] = []
  return {
    context: {
      options: { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" },
      client: {
        global: { health: async () => ({ data: { healthy: true, version } }) },
      },
      data: {
        on(type: string) {
          subscriptions.push(type)
          return () => {}
        },
        session: {
          root: (id: string) => id,
          get: (id: string) => ({ id }),
          message: { list: () => [], get: () => undefined, sync: async () => {} },
          permission: { list: () => [], sync: async () => {} },
        },
      },
      ui: { toast: { show() {} } },
    } as unknown as Context,
    subscriptions,
  }
}

describe("TUI plugin runtime ownership", () => {
  test("owns V2 permission events", async () => {
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
