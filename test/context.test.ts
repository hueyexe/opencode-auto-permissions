import { describe, expect, test } from "bun:test"
import { collectReviewInput, normalizeAskedEvent } from "../src/context.ts"
import { buildReviewPrompt } from "../src/prompt.ts"
import type { PermissionRequest, RuntimeContext } from "../src/types.ts"

describe("review context isolation", () => {
  test("detects stable and V2 permission payloads sharing the same event name", () => {
    expect(
      normalizeAskedEvent({
        type: "permission.asked",
        data: { id: "per_v2", sessionID: "ses_1", action: "shell", resources: ["git status"], always: ["git status*"] },
      }),
    ).toMatchObject({ id: "per_v2", action: "shell", always: ["git status*"], protocol: "v2" })

    expect(
      normalizeAskedEvent({
        type: "permission.asked",
        data: { id: "per_stable", sessionID: "ses_1", permission: "bash", patterns: ["git status"], always: ["git status*"] },
      }),
    ).toMatchObject({ id: "per_stable", action: "bash", always: ["git status*"], protocol: "stable" })
  })

  test("includes only real human text and excludes ambient or agent content", async () => {
    const context: RuntimeContext = {
      options: {},
      client: {},
      data: {
        on: () => () => {},
        session: {
          root: () => "ses_root",
          get: (id) => ({ id }),
          message: {
            list: () => [
              {
                info: {
                  id: "msg_user",
                  role: "user",
                  model: { providerID: "cloudflare-workers-ai", modelID: "@cf/deepseek-ai/deepseek-v4-flash-0731", variant: "high" },
                },
                parts: [
                  { type: "text", text: "DEFAULT SYSTEM PROMPT", synthetic: true },
                  { type: "text", text: "IGNORED PLUGIN INSTRUCTION", ignored: true },
                  { type: "text", text: "Real human instruction" },
                ],
              },
              {
                info: { id: "msg_assistant", role: "assistant" },
                parts: [
                  { type: "text", text: "ASSISTANT RATIONALE" },
                  { type: "tool", callID: "call_1", state: { output: "TOOL OUTPUT" } },
                ],
              },
              {
                info: { id: "msg_plugin", role: "user" },
                parts: [{
                  type: "text",
                  text: "[Auto Permissions] The requested action was blocked: Complete reviews first.",
                }],
              },
              {
                info: { id: "msg_approval", role: "user" },
                parts: [{ type: "text", text: "The reviews are complete. I approve the push." }],
              },
            ],
            get: () => undefined,
            sync: async () => {},
          },
          permission: { list: () => [], sync: async () => {} },
        },
        location: { default: () => ({ directory: "/repo" }) },
      },
    }
    const request: PermissionRequest = {
      id: "per_1",
      sessionID: "ses_root",
      action: "bash",
      resources: ["git push origin feature"],
      always: [],
      protocol: "stable",
    }

    const input = await collectReviewInput(context, request, 4)
    const prompt = buildReviewPrompt(input)

    expect(input.context.userMessages).toEqual([
      "Real human instruction",
      "The reviews are complete. I approve the push.",
    ])
    expect(input.context.model).toEqual({ providerID: "cloudflare-workers-ai", id: "@cf/deepseek-ai/deepseek-v4-flash-0731", variant: "high" })
    expect(input.request.sessionPatterns).toEqual([])
    expect(prompt).toContain("Real human instruction")
    expect(prompt).not.toContain("DEFAULT SYSTEM PROMPT")
    expect(prompt).not.toContain("IGNORED PLUGIN INSTRUCTION")
    expect(prompt).not.toContain("ASSISTANT RATIONALE")
    expect(prompt).not.toContain("TOOL OUTPUT")
    expect(prompt).not.toContain("Complete reviews first")
  })

  test("includes delegated human instructions from the requesting child session", async () => {
    const messages = new Map<string, unknown[]>([
      ["ses_root", [{
        info: {
          role: "user",
          model: { providerID: "kiro", modelID: "gpt-5.6-sol", variant: "high" },
        },
        parts: [{ type: "text", text: "Implement the change and finish the task." }],
      }]],
      ["ses_child", [{
        info: {
          role: "user",
          model: { providerID: "kiro", modelID: "gpt-5.6-mini", variant: "low" },
        },
        parts: [{ type: "text", text: "Push the completed branch to main." }],
      }]],
    ])
    const synced: string[] = []
    const context: RuntimeContext = {
      options: {},
      client: {},
      data: {
        on: () => () => {},
        session: {
          root: () => "ses_root",
          get: (id) => id === "ses_child" ? { id, parentID: "ses_root" } : { id },
          message: {
            list: (sessionID) => messages.get(sessionID) ?? [],
            get: () => undefined,
            sync: async (sessionID) => { synced.push(sessionID) },
          },
          permission: { list: () => [], sync: async () => {} },
        },
        location: { default: () => ({ directory: "/repo" }) },
      },
    }

    const input = await collectReviewInput(context, {
      id: "per_child",
      sessionID: "ses_child",
      action: "shell",
      resources: ["git push origin main"],
      always: [],
      protocol: "v2",
    }, 8)

    expect(synced).toEqual(["ses_root", "ses_child"])
    expect(input.context.userMessages).toEqual([
      "Implement the change and finish the task.",
      "Push the completed branch to main.",
    ])
    expect(input.context.model).toEqual({ providerID: "kiro", id: "gpt-5.6-mini", variant: "low" })
  })
})
