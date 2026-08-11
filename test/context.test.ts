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
                info: { id: "msg_user", role: "user" },
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

    expect(input.context.userMessages).toEqual(["Real human instruction"])
    expect(input.request.sessionPatterns).toEqual([])
    expect(prompt).toContain("Real human instruction")
    expect(prompt).not.toContain("DEFAULT SYSTEM PROMPT")
    expect(prompt).not.toContain("IGNORED PLUGIN INSTRUCTION")
    expect(prompt).not.toContain("ASSISTANT RATIONALE")
    expect(prompt).not.toContain("TOOL OUTPUT")
  })
})
