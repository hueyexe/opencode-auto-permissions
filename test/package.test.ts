import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import packageJson from "../package.json"

const dist = resolve(import.meta.dir, "../dist")

describe("built package", () => {
  test("is publishable with native OpenCode server and TUI targets", () => {
    expect(Reflect.has(packageJson, "private")).toBeFalse()
    expect(packageJson.publishConfig).toEqual({ access: "public" })
    expect(packageJson.exports).toMatchObject({
      "./server": "./dist/server.js",
      "./tui": "./dist/tui.js",
    })
  })

  test("exports both current-beta and transitional TUI entrypoints", async () => {
    const build = Bun.spawn(["bun", "run", "build"], { cwd: resolve(import.meta.dir, "..") })
    expect(await build.exited).toBe(0)

    const mod = await import(resolve(dist, "tui.js") + `?test=${Date.now()}`)
    expect(mod.default).toMatchObject({ id: "opencode.auto-permissions" })
    expect(typeof mod.default.setup).toBe("function")
    expect(mod.id).toBe("opencode.auto-permissions")
    expect(typeof mod.tui).toBe("function")

    const server = await import(resolve(dist, "server.js") + `?test=${Date.now()}`)
    expect(server.default).toMatchObject({ id: "opencode.auto-permissions.server" })
    expect(typeof server.default.setup).toBe("function")
    expect(typeof server.default.server).toBe("function")
  })
})
