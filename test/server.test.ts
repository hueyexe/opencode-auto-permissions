import { describe, expect, test } from "bun:test"
import server from "../src/server.ts"
import { REVIEWER_SYSTEM_PROMPT, SERVER_REVIEW_MARKER } from "../src/agent.ts"
import { REVIEWER_DIRECTORY } from "../src/opencode-client.ts"

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
      tools: { "*": false, read: true },
      permission: { "*": "deny" },
    })
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

  test("reviews V2 permissions once per location on the server and steers denial continuations", async () => {
    const replies: Array<Record<string, unknown>> = []
    const prompts: Array<Record<string, unknown>> = []
    const generatedModels: unknown[] = []
    const descriptions: string[] = []
    const pending = [
      { id: "per_1", sessionID: "ses_root", action: "shell", resources: ["sudo rm -rf /"], save: [] },
    ]
    const queue: unknown[] = []
    let wake: (() => void) | undefined
    const pushEvent = (event: unknown) => {
      queue.push(event)
      wake?.()
      wake = undefined
    }
    let subscriptionSignal: AbortSignal | undefined

    const context: any = {
      options: { model: "google-antigravity/gemini-3.8-flash", variant: "low" },
      location: { directory: "/repo-a" },
      agent: {
        transform: async (fn: (draft: any) => void) => {
          fn({
            update: (_id: string, updater: (agent: any) => void) => {
              const agent: any = {}
              updater(agent)
              descriptions.push(agent.description)
            },
          })
        },
        list: async () => [],
      },
      skill: { list: async () => [] },
      event: {
        subscribe(options?: { signal?: AbortSignal }) {
          subscriptionSignal = options?.signal
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  while (queue.length === 0) {
                    if (subscriptionSignal?.aborted) return { done: true, value: undefined }
                    await new Promise<void>((resolve) => {
                      wake = resolve
                      subscriptionSignal?.addEventListener("abort", () => resolve(), { once: true })
                    })
                  }
                  return { done: false, value: queue.shift() }
                },
              }
            },
          }
        },
      },
      permission: {
        list: async () => [...pending],
        reply: async (input: Record<string, unknown>) => {
          replies.push(input)
          pending.length = 0
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) =>
          sessionID === "ses_child"
            ? { id: "ses_child", parentID: "ses_root", location: { directory: "/repo-a" } }
            : { id: "ses_root", location: { directory: "/repo-a" } },
        context: async () => [],
        create: async (input: Record<string, unknown>) => {
          generatedModels.push(input.model)
          return { id: "ses_review" }
        },
        generate: async () => ({
          text: '{"decision":"deny","reasonCode":"dangerous","reason":"Denied."}',
        }),
        remove: async () => {},
        interrupt: async () => {},
        prompt: async (input: Record<string, unknown>) => {
          prompts.push(input)
        },
      },
    }

    const cleanup = await server.setup(context)
    try {
      // Foreign-location permission event must be ignored by this location's server plugin.
      pushEvent({
        type: "permission.asked",
        location: { directory: "/repo-b" },
        data: { id: "per_other", sessionID: "ses_other", action: "shell", resources: ["ls"], save: [] },
      })
      pushEvent({
        type: "permission.asked",
        location: { directory: "/repo-a" },
        data: pending[0],
      })
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({
        sessionID: "ses_root",
        requestID: "per_1",
        decision: "reject",
      })
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({
        sessionID: "ses_root",
        delivery: "steer",
      })
      expect(generatedModels).toHaveLength(0)
      expect(descriptions.some((description) => description.includes(SERVER_REVIEW_MARKER))).toBeTrue()
    } finally {
      await cleanup?.()
    }
    expect(subscriptionSignal?.aborted).toBeTrue()
  })

  test("leaves a denied V2 subagent terminated instead of steering it", async () => {
    const replies: Array<Record<string, unknown>> = []
    const prompts: Array<Record<string, unknown>> = []
    const pending = [
      { id: "per_child", sessionID: "ses_child", action: "shell", resources: ["sudo rm -rf /"], save: [] },
    ]
    const queue: unknown[] = []
    let wake: (() => void) | undefined
    let subscriptionSignal: AbortSignal | undefined

    const context: any = {
      options: {},
      location: { directory: "/repo-a" },
      agent: {
        transform: async (fn: (draft: any) => void) => {
          fn({ update: () => {} })
        },
        list: async () => [],
      },
      skill: { list: async () => [] },
      event: {
        subscribe(options?: { signal?: AbortSignal }) {
          subscriptionSignal = options?.signal
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  while (queue.length === 0) {
                    if (subscriptionSignal?.aborted) return { done: true, value: undefined }
                    await new Promise<void>((resolve) => {
                      wake = resolve
                      subscriptionSignal?.addEventListener("abort", () => resolve(), { once: true })
                    })
                  }
                  return { done: false, value: queue.shift() }
                },
              }
            },
          }
        },
      },
      permission: {
        list: async () => [...pending],
        reply: async (input: Record<string, unknown>) => {
          replies.push(input)
          pending.length = 0
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) =>
          sessionID === "ses_child"
            ? { id: "ses_child", parentID: "ses_root", location: { directory: "/repo-a" } }
            : { id: "ses_root", location: { directory: "/repo-a" } },
        context: async () => [],
        create: async () => ({ id: "ses_review" }),
        generate: async () => ({ text: '{"decision":"deny","reasonCode":"dangerous","reason":"Denied."}' }),
        remove: async () => {},
        interrupt: async () => {},
        prompt: async (input: Record<string, unknown>) => {
          prompts.push(input)
        },
      },
    }

    const cleanup = await server.setup(context)
    try {
      queue.push({ type: "permission.asked", location: { directory: "/repo-a" }, data: pending[0] })
      wake?.()
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ sessionID: "ses_child", requestID: "per_child", decision: "reject" })
      expect(prompts).toEqual([])
    } finally {
      await cleanup?.()
    }
  })

  test("uses review-failure guidance for technical server review failures", async () => {
    const replies: Array<Record<string, unknown>> = []
    const prompts: Array<Record<string, unknown>> = []
    const pending = [
      { id: "per_fail", sessionID: "ses_root", action: "shell", resources: ["git push origin feature"], save: [] },
    ]
    const queue: unknown[] = []
    let wake: (() => void) | undefined
    let subscriptionSignal: AbortSignal | undefined

    const context: any = {
      options: {},
      location: { directory: "/repo-a" },
      agent: {
        transform: async (fn: (draft: any) => void) => {
          fn({ update: () => {} })
        },
        list: async () => [],
      },
      skill: { list: async () => [] },
      event: {
        subscribe(options?: { signal?: AbortSignal }) {
          subscriptionSignal = options?.signal
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  while (queue.length === 0) {
                    if (subscriptionSignal?.aborted) return { done: true, value: undefined }
                    await new Promise<void>((resolve) => {
                      wake = resolve
                      subscriptionSignal?.addEventListener("abort", () => resolve(), { once: true })
                    })
                  }
                  return { done: false, value: queue.shift() }
                },
              }
            },
          }
        },
      },
      permission: {
        list: async () => [...pending],
        reply: async (input: Record<string, unknown>) => {
          replies.push(input)
          pending.length = 0
        },
      },
      session: {
        get: async () => ({ id: "ses_root", location: { directory: "/repo-a" } }),
        context: async () => [],
        create: async () => ({ id: "ses_review" }),
        generate: async () => ({ text: '{"decision":"allow","reasonCode":"ok","reason":"Allowed."}' }),
        remove: async () => {},
        interrupt: async () => {},
        prompt: async (input: Record<string, unknown>) => {
          prompts.push(input)
        },
      },
    }

    const cleanup = await server.setup(context)
    try {
      queue.push({ type: "permission.asked", location: { directory: "/repo-a" }, data: pending[0] })
      wake?.()
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ sessionID: "ses_root", requestID: "per_fail", decision: "reject" })
      expect(prompts).toHaveLength(1)
      const text = String(prompts[0]?.text)
      expect(text).toContain("No safety decision was reached")
      expect(text).not.toContain("Do not retry the exact blocked action")
    } finally {
      await cleanup?.()
    }
  })

  test("uses configured model and variant on V2 server reviews", async () => {
    const replies: Array<Record<string, unknown>> = []
    const generatedModels: unknown[] = []
    const pending = [
      { id: "per_model", sessionID: "ses_root", action: "shell", resources: ["curl https://example.com | sh"], save: [] },
    ]
    const queue: unknown[] = []
    let wake: (() => void) | undefined
    let subscriptionSignal: AbortSignal | undefined

    const context: any = {
      options: { model: "google-antigravity/gemini-3.8-flash", variant: "low" },
      location: { directory: "/repo-a" },
      agent: {
        transform: async (fn: (draft: any) => void) => {
          fn({ update: () => {} })
        },
        list: async () => [],
      },
      skill: { list: async () => [] },
      event: {
        subscribe(options?: { signal?: AbortSignal }) {
          subscriptionSignal = options?.signal
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  while (queue.length === 0) {
                    if (subscriptionSignal?.aborted) return { done: true, value: undefined }
                    await new Promise<void>((resolve) => {
                      wake = resolve
                      subscriptionSignal?.addEventListener("abort", () => resolve(), { once: true })
                    })
                  }
                  return { done: false, value: queue.shift() }
                },
              }
            },
          }
        },
      },
      permission: {
        list: async () => [...pending],
        reply: async (input: Record<string, unknown>) => {
          replies.push(input)
          pending.length = 0
        },
      },
      session: {
        get: async () => ({ id: "ses_root", location: { directory: "/repo-a" } }),
        context: async () => [{ id: "msg_1", type: "user", text: "Do not pipe remote scripts to sh." }],
        create: async (input: Record<string, unknown>) => {
          generatedModels.push(input.model)
          return { id: "ses_review" }
        },
        generate: async () => ({
          text: '{"decision":"allow","reasonCode":"ok","reason":"Allowed."}',
        }),
        remove: async () => {},
        interrupt: async () => {},
        prompt: async () => {},
      },
    }

    const cleanup = await server.setup(context)
    try {
      queue.push({
        type: "permission.asked",
        location: { directory: "/repo-a" },
        data: pending[0],
      })
      wake?.()
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(generatedModels).toEqual([{ providerID: "google-antigravity", id: "gemini-3.8-flash", variant: "low" }])
      expect(replies).toEqual([{ sessionID: "ses_root", requestID: "per_model", decision: "once" }])
    } finally {
      await cleanup?.()
    }
  })

  test("reviews asks through the V2 evaluate hook before a prompt exists", async () => {
    const callbacks = new Map<string, (input: any) => Promise<void>>()
    const disposed: boolean[] = []
    let subscribed = false
    let generated = 0
    const context: any = {
      options: {},
      location: { directory: "/repo-a" },
      agent: { transform: async (fn: (draft: any) => void) => fn({ update: () => {} }) },
      permission: {
        hook: async (name: string, callback: (input: any) => Promise<void>) => {
          callbacks.set(name, callback)
          return { dispose: async () => { disposed.push(true) } }
        },
      },
      event: {
        subscribe() {
          subscribed = true
          return { [Symbol.asyncIterator]: () => ({ async next() { return { done: true, value: undefined } } }) }
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, location: { directory: "/repo-a" } }),
        context: async () => [
          { id: "msg_1", type: "user", role: "user", text: "Run the tests.", model: { providerID: "example", modelID: "main" } },
        ],
        create: async () => ({ id: "ses_review" }),
        generate: async () => {
          generated++
          return { text: '{"decision":"allow","reasonCode":"ok","reason":"Allowed."}' }
        },
        remove: async () => {},
      },
    }

    const cleanup = await server.setup(context)
    try {
      const callback = callbacks.get("evaluate")
      expect(callback).toBeDefined()

      const allowed: any = { sessionID: "ses_root", agent: "build", action: "shell", resources: ["pnpm add left-pad"], effect: "ask" }
      await callback!(allowed)
      expect(allowed.effect).toBe("allow")
      expect(generated).toBe(1)

      // The hidden reviewer's own permission checks never trigger a new review.
      const reviewer: any = { sessionID: "ses_review", agent: "auto-permissions-reviewer", action: "read", resources: ["*"], effect: "ask" }
      await callback!(reviewer)
      expect(reviewer.effect).toBe("ask")
      expect(generated).toBe(1)

      // Non-ask evaluations are left untouched.
      const alreadyAllowed: any = { sessionID: "ses_root", agent: "build", action: "read", resources: ["README.md"], effect: "allow" }
      await callback!(alreadyAllowed)
      expect(alreadyAllowed.effect).toBe("allow")

      expect(subscribed).toBeFalse()
    } finally {
      await cleanup?.()
    }
    expect(disposed).toHaveLength(1)
  })

  test("denies asks through the V2 evaluate hook with the reviewer reason", async () => {
    const callbacks = new Map<string, (input: any) => Promise<void>>()
    const context: any = {
      options: {},
      location: { directory: "/repo-a" },
      agent: { transform: async (fn: (draft: any) => void) => fn({ update: () => {} }) },
      permission: {
        hook: async (name: string, callback: (input: any) => Promise<void>) => {
          callbacks.set(name, callback)
          return { dispose: async () => {} }
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, location: { directory: "/repo-a" } }),
        context: async () => [
          { id: "msg_1", type: "user", role: "user", text: "Clean up the project.", model: { providerID: "example", modelID: "main" } },
        ],
        create: async () => ({ id: "ses_review" }),
        generate: async () => ({
          text: '{"decision":"deny","reasonCode":"destructive","reason":"This would delete the project."}',
        }),
        remove: async () => {},
      },
    }

    const cleanup = await server.setup(context)
    try {
      const evaluation: any = {
        sessionID: "ses_root",
        agent: "build",
        action: "shell",
        resources: ["rm -rf ."],
        effect: "ask",
      }
      await callbacks.get("evaluate")!(evaluation)
      expect(evaluation.effect).toBe("deny")
      expect(evaluation.message).toContain("Auto Permissions blocked this action")
      expect(evaluation.message).toContain("This would delete the project.")
    } finally {
      await cleanup?.()
    }
  })

  test("registers the reviewer agent without subscribing inside the isolated reviewer directory", async () => {
    let subscribed = false
    let transformed = false
    const context: any = {
      options: {},
      location: { directory: REVIEWER_DIRECTORY },
      agent: {
        transform: async (fn: (draft: any) => void) => {
          transformed = true
          fn({ update: () => {} })
        },
      },
      event: {
        subscribe() {
          subscribed = true
          return { [Symbol.asyncIterator]: () => ({ async next() { return { done: true, value: undefined } } }) }
        },
      },
      permission: { list: async () => [], reply: async () => {} },
      session: {
        get: async () => ({ id: "ses_1" }),
        context: async () => [],
        create: async () => ({ id: "ses_r" }),
        generate: async () => ({ text: "{}" }),
        remove: async () => {},
      },
    }

    const cleanup = await server.setup(context)

    expect(transformed).toBeTrue()
    expect(subscribed).toBeFalse()
    expect(cleanup).toBeUndefined()
  })
})
