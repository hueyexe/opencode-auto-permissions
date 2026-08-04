import { describe, expect, test } from "bun:test"
import { parseDecision } from "../src/verdict.ts"

describe("parseDecision", () => {
  test("accepts an exact structured decision", () => {
    expect(
      parseDecision({ decision: "allow", reasonCode: "routine_test", reason: "Runs local tests." }),
    ).toEqual({ kind: "allow", reasonCode: "routine_test", reason: "Runs local tests." })
  })

  test.each([
    "",
    null,
    { decision: "allow", reasonCode: "x", reason: "ok", extra: true },
    { decision: "SAFE", reasonCode: "x", reason: "ok" },
    { decision: "allow", reasonCode: "Not-Snake", reason: "ok" },
    { decision: "allow", reasonCode: "x", reason: "" },
  ])("rejects malformed output %#", (value) => {
    expect(parseDecision(value)).toBeNull()
  })
})
