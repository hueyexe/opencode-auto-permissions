import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { rmSync } from "node:fs"
import { createServer } from "node:net"
import { get } from "node:http"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parse } from "jsonc-parser"

const runtime = process.argv[2]
const headless = process.argv.includes("--headless")
if (runtime !== "stable" && runtime !== "v2") {
  throw new Error("Usage: bun run scripts/test-runtime.ts <stable|v2>")
}

const root = resolve(import.meta.dir, "..")
const localBin = join(root, "node_modules", ".bin")
const stablePath = (process.env.PATH ?? "")
  .split(":")
  .filter((entry) => resolve(entry) !== localBin)
  .join(":")
const pinnedBeta = join(localBin, "opencode")
const stableBinary = Bun.which("opencode", { PATH: stablePath })
if (runtime === "stable" && !stableBinary) throw new Error("Stable OpenCode is not available outside this repository")
const binary = runtime === "stable" ? stableBinary! : pinnedBeta
const expectedVersion = runtime === "stable" ? undefined : "0.0.0-beta-202608040144"
const model = process.env.AUTO_PERMISSIONS_MODEL ?? "kiro-openai/gpt-5.6-luna"
const separator = model.indexOf("/")
if (separator < 1 || separator === model.length - 1) throw new Error(`Invalid reviewer model: ${model}`)
const providerID = model.slice(0, separator)
const modelID = model.slice(separator + 1)
const testRoot = join("/tmp", `opencode-auto-permissions-${runtime}-test`)
const lockDirectory = join("/tmp", "opencode-auto-permissions-runtime-test.lock")
const configRoot = join(testRoot, "config")
const opencodeConfig = join(configRoot, "opencode", "opencode.json")
const cliConfig = join(configRoot, "opencode", "cli.json")
const logFile = join(testRoot, "server.log")

await acquireLock()
process.on("exit", releaseLockSync)

await run(["bun", "run", "verify"], process.env)
const version = (await output([binary, "--version"], process.env)).trim()
if (expectedVersion && version !== expectedVersion) {
  throw new Error(`Expected OpenCode ${expectedVersion}, found ${version}`)
}
if (runtime === "stable" && version.startsWith("0.0.0-beta")) {
  throw new Error(`Stable launcher resolved a beta OpenCode build: ${binary}`)
}

const source = parse(await readFile(join(homedir(), ".config", "opencode", "opencode.json"), "utf8"))
const provider = source?.provider?.[providerID]
if (!provider) throw new Error(`Provider ${providerID} is not configured in ~/.config/opencode/opencode.json`)
if (!provider.models?.[modelID]) {
  const available = Object.keys(provider.models ?? {}).join(", ") || "none"
  throw new Error(`Model ${model} is not configured. Available ${providerID} models: ${available}`)
}

await rm(testRoot, { recursive: true, force: true })
await Promise.all([
  mkdir(dirname(opencodeConfig), { recursive: true }),
  mkdir(join(testRoot, "data"), { recursive: true }),
  mkdir(join(testRoot, "state"), { recursive: true }),
  mkdir(join(testRoot, "cache"), { recursive: true }),
])

const options = { model }
await writeFile(
  opencodeConfig,
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: { [providerID]: provider },
      plugin: [[join(root, "dist", "server.js"), options]],
      permission: { bash: "ask", external_directory: "ask" },
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
)

await writeFile(
  cliConfig,
  JSON.stringify(
    runtime === "v2"
      ? { plugins: [{ package: join(root, "dist", "tui.js"), options }] }
      : {},
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
)

const port = await freePort()
const env = {
  ...process.env,
  ...(runtime === "stable" ? { PATH: stablePath } : {}),
  XDG_CONFIG_HOME: configRoot,
  XDG_DATA_HOME: join(testRoot, "data"),
  XDG_STATE_HOME: join(testRoot, "state"),
  XDG_CACHE_HOME: join(testRoot, "cache"),
  OPENCODE_DB: ":memory:",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
}

const server = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root,
  env,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
})
const logs = captureProcess(server)

const stop = () => {
  if (!server.killed) server.kill()
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)

try {
  await waitForHealth(port)
  console.log(`OpenCode ${version} (${runtime})`)
  console.log(`Reviewer model: ${model}`)
  console.log(`Isolated test state: ${testRoot}`)
  console.log(`Server log: ${logFile}`)
  if (headless) {
    console.log("Headless launcher check passed.")
  } else {
    console.log("Exit the TUI normally when testing is complete.")
    const tui = Bun.spawn([binary, "attach", `http://127.0.0.1:${port}`, "--dir", root], {
      cwd: root,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    process.exitCode = await tui.exited
  }
} finally {
  await stopProcess(server)
  await logs.finish(logFile)
  await rm(lockDirectory, { recursive: true, force: true })
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await healthy(port)) return
    await Bun.sleep(100)
  }
  throw new Error(`OpenCode server did not start; see ${logFile}`)
}

function healthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get({ hostname: "127.0.0.1", port, path: "/api/health", timeout: 500 }, (response) => {
      response.resume()
      resolve(response.statusCode === 200)
    })
    request.once("error", () => resolve(false))
    request.once("timeout", () => {
      request.destroy()
      resolve(false)
    })
  })
}

async function run(command: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const process = Bun.spawn(command, { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const status = await process.exited
  if (status !== 0) throw new Error(`${command.join(" ")} failed with exit code ${status}`)
}

async function output(command: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const process = Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "inherit" })
  const text = await new Response(process.stdout).text()
  const status = await process.exited
  if (status !== 0) throw new Error(`${command.join(" ")} failed with exit code ${status}`)
  return text
}

function captureProcess(process: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const chunks: ArrayBuffer[] = []
  const readers = [capture(process.stdout, chunks), capture(process.stderr, chunks)]
  return {
    async finish(file: string) {
      await Promise.race([Promise.all(readers.map((reader) => reader.done)), Bun.sleep(500)])
      await Promise.all(readers.map((reader) => reader.cancel()))
      await Bun.write(file, new Blob(chunks))
    },
  }
}

function capture(stream: ReadableStream<Uint8Array>, chunks: ArrayBuffer[]) {
  const reader = stream.getReader()
  const done = (async () => {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      chunks.push(Uint8Array.from(next.value).buffer)
    }
  })().catch(() => undefined)
  return {
    done,
    cancel: () => reader.cancel().catch(() => undefined),
  }
}

async function stopProcess(process: Bun.Subprocess): Promise<void> {
  if (!process.killed) process.kill()
  const stopped = await Promise.race([process.exited.then(() => true), Bun.sleep(2_000).then(() => false)])
  if (stopped) return
  process.kill(9)
  await Promise.race([process.exited, Bun.sleep(1_000)])
}

async function acquireLock(): Promise<void> {
  try {
    await mkdir(lockDirectory)
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "EEXIST") {
      throw new Error("Another Auto Permissions runtime test is already running")
    }
    throw error
  }
}

function releaseLockSync(): void {
  try {
    rmSync(lockDirectory, { recursive: true, force: true })
  } catch {}
}
