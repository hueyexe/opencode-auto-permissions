import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Decision, PermissionRequest } from "./types.ts"

const MAX_RECORDS = 100
const queues = new Map<string, Promise<void>>()

export interface DiagnosticRecord {
  timestamp: string
  event: "plugin_started" | "request_received" | "request_cancelled" | "decision" | "failure"
  requestID?: string
  sessionID?: string
  protocol?: PermissionRequest["protocol"]
  action?: string
  resourceCount?: number
  elapsedMs?: number
  source?: "policy" | "model" | "session"
  decision?: Decision["kind"]
  approvalScope?: "once" | "session"
  reasonCode?: string
  reason?: string
  shadow?: boolean
  replyResult?: "replied" | "not_found" | "manual"
  failureCategory?: "timeout" | "cancelled" | "invalid_response" | "error"
  errorName?: string
  errorMessage?: string
  errorTag?: string
  errorCode?: string | number
  errorStatus?: string | number
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
  const message = describeError(error).message
  if (/timed out/i.test(message)) return "timeout"
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled"
  if (/invalid decision|no structured output|invalid response/i.test(message)) return "invalid_response"
  return "error"
}

export function describeError(error: unknown): {
  name: string
  message: string
  tag?: string
  code?: string | number
  status?: string | number
} {
  const records = nestedRecords(error)
  const name = firstString(records, ["name"]) ?? (error instanceof Error ? error.name : "Error")
  const message = firstString(records, ["message", "detail", "reason", "error_description"])
    ?? (typeof error === "string" ? error : "Unknown non-Error failure")
  const tag = firstString(records, ["_tag", "type"])
  const code = firstScalar(records, ["code"])
  const status = firstScalar(records, ["status", "statusCode"])
  return {
    name: bounded(name),
    message: bounded(message),
    ...(tag ? { tag: bounded(tag) } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
  }
}

function nestedRecords(value: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  let current = value
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const record = current as Record<string, unknown>
    records.push(record)
    current = record.error ?? record.data ?? record.cause
  }
  return records
}

function firstString(records: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      if (typeof record[key] === "string" && record[key]) return record[key]
    }
  }
}

function firstScalar(records: Record<string, unknown>[], keys: string[]): string | number | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === "string" || typeof value === "number") return value
    }
  }
}

function bounded(value: string): string {
  return value.slice(0, 500)
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
