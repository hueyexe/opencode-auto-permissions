import { describe, expect, test } from "bun:test"
import { parseConfig } from "../src/config.ts"

describe("parseConfig", () => {
  test("parses an arbitrary provider/model reference", () => {
    expect(parseConfig({ model: "example/luna-5.6" })).toEqual({
      model: { providerID: "example", id: "luna-5.6" },
      modelLabel: "example/luna-5.6",
      timeoutMs: 8_000,
      userMessageCount: 4,
      shadow: false,
      runtime: "auto",
    })
  })

  test("allows slashes inside the model id", () => {
    expect(parseConfig({ model: "provider/org/model" }).model).toEqual({
      providerID: "provider",
      id: "org/model",
    })
  })

  test.each([{}, { model: "luna" }, { model: "/luna" }, { model: "provider/" }])(
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
})
