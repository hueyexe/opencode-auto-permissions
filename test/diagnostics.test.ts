import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeError, failureCategory, writeDiagnostic } from "../src/diagnostics.ts"

describe("diagnostics", () => {
  test("describes nested SDK error objects", () => {
    const error = {
      status: 400,
      error: {
        _tag: "ProviderError",
        code: "invalid_request",
        data: { message: "Structured output is unavailable." },
      },
    }

    expect(describeError(error)).toEqual({
      name: "Error",
      message: "Structured output is unavailable.",
      tag: "ProviderError",
      code: "invalid_request",
      status: 400,
    })
    expect(failureCategory(error)).toBe("error")
  })

  test("retains only the latest 100 privacy-minimized records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auto-permissions-diagnostics-"))
    const path = join(directory, "decisions.jsonl")
    try {
      for (let index = 0; index < 105; index++) {
        writeDiagnostic(path, {
          timestamp: new Date(index).toISOString(),
          event: "decision",
          requestID: `per_${index}`,
          sessionID: "ses_test",
          protocol: "stable",
          action: "bash",
          resourceCount: 1,
          elapsedMs: index,
          decision: "allow",
        })
      }
      await waitForLines(path, 100)

      const lines = (await readFile(path, "utf8")).trim().split("\n")
      expect(lines).toHaveLength(100)
      expect(JSON.parse(lines[0]!).requestID).toBe("per_5")
      expect(JSON.parse(lines.at(-1)!).requestID).toBe("per_104")
      expect(await Bun.file(path).stat()).toMatchObject({ mode: expect.any(Number) })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

async function waitForLines(path: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const text = await readFile(path, "utf8").catch(() => "")
    if (text.trim().split("\n").filter(Boolean).length === expected && text.includes("per_104")) return
    await Bun.sleep(10)
  }
  throw new Error("Diagnostics did not flush")
}
