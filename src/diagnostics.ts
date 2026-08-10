import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Decision, PermissionRequest } from "./types.ts"

const MAX_RECORDS = 100
const queues = new Map<string, Promise<void>>()

export interface DiagnosticRecord {
  timestamp: string
  requestID: string
  sessionID: string
  protocol: PermissionRequest["protocol"]
  action: string
  resourceCount: number
  elapsedMs: number
  outcome: "decision" | "failure"
  source?: "policy" | "model"
  decision?: Decision["kind"]
  reasonCode?: string
  reason?: string
  shadow?: boolean
  replyResult?: "replied" | "not_found" | "manual"
  failureCategory?: "timeout" | "cancelled" | "invalid_response" | "error"
  errorName?: string
  errorMessage?: string
}

export function defaultDiagnosticsPath(): string {
  const stateRoot = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  return join(stateRoot, "opencode", "auto-permissions", "decisions.jsonl")
}

export function writeDiagnostic(path: string | undefined, record: DiagnosticRecord): void {
  if (!path) return
  const previous = queues.get(path) ?? Promise.resolve()
  const next = previous.then(() => appendBounded(path, record)).catch(() => undefined)
  queues.set(path, next)
  void next.finally(() => {
    if (queues.get(path) === next) queues.delete(path)
  })
}

export function failureCategory(error: unknown): NonNullable<DiagnosticRecord["failureCategory"]> {
  const message = error instanceof Error ? error.message : String(error)
  if (/timed out/i.test(message)) return "timeout"
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled"
  if (/invalid decision|no structured output|invalid response/i.test(message)) return "invalid_response"
  return "error"
}

async function appendBounded(path: string, record: DiagnosticRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  const records = existing.split("\n").filter(Boolean)
  records.push(JSON.stringify(record))
  await writeFile(path, records.slice(-MAX_RECORDS).join("\n") + "\n", { mode: 0o600 })
}
