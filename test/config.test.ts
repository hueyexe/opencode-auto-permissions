import { describe, expect, test } from "bun:test"
import { parseConfig } from "../src/config.ts"

describe("parseConfig", () => {
  test("parses an arbitrary provider/model reference", () => {
    expect(parseConfig({ model: "openai/gpt-5.6-luna" })).toEqual({
      model: { providerID: "openai", id: "gpt-5.6-luna" },
      modelLabel: "openai/gpt-5.6-luna",
      variant: undefined,
      timeoutMs: 30_000,
      userMessageCount: 8,
      shadow: false,
      sessionApprovals: true,
      runtime: "auto",
      diagnosticsPath: undefined,
    })
  })

  test("allows slashes inside the model id", () => {
    expect(parseConfig({ model: "provider/org/model" }).model).toEqual({
      providerID: "provider",
      id: "org/model",
    })
  })

  test("applies an optional reviewer variant", () => {
    expect(parseConfig({ model: "openai/gpt-5.6-luna", variant: "low" }).model).toEqual({
      providerID: "openai",
      id: "gpt-5.6-luna",
      variant: "low",
    })
    expect(() => parseConfig({ model: "a/b", variant: "" })).toThrow(/variant/)
  })

  test("inherits the requesting session model by default", () => {
    expect(parseConfig({})).toMatchObject({ model: undefined, modelLabel: undefined, variant: undefined })
  })

  test.each([{ model: "" }, { model: "gpt-5.6-luna" }, { model: "/gpt-5.6-luna" }, { model: "provider/" }])(
    "rejects invalid model option %#",
    (options) => expect(() => parseConfig(options)).toThrow(),
  )

  test("rejects out-of-range runtime options", () => {
    expect(() => parseConfig({ model: "a/b", timeoutMs: 99 })).toThrow(/timeoutMs/)
    expect(() => parseConfig({ model: "a/b", userMessageCount: 21 })).toThrow(/userMessageCount/)
  })

  test("supports a diagnostics-only runtime override", () => {
    expect(parseConfig({ model: "a/b", runtime: "stable" }).runtime).toBe("stable")
    expect(parseConfig({ model: "a/b", runtime: "v2" }).runtime).toBe("v2")
    expect(() => parseConfig({ model: "a/b", runtime: "other" })).toThrow(/runtime/)
  })

  test("allows session approvals to be disabled", () => {
    expect(parseConfig({ model: "a/b" }).sessionApprovals).toBeTrue()
    expect(parseConfig({ model: "a/b", sessionApprovals: false }).sessionApprovals).toBeFalse()
  })

  test("enables bounded diagnostics with a default or explicit path", () => {
    expect(parseConfig({ model: "a/b", debug: true }).diagnosticsPath).toEndWith("opencode/auto-permissions/decisions.jsonl")
    expect(parseConfig({ model: "a/b", debug: "/tmp/decisions.jsonl" }).diagnosticsPath).toBe("/tmp/decisions.jsonl")
    expect(() => parseConfig({ model: "a/b", debug: 1 })).toThrow(/debug/)
  })
})
