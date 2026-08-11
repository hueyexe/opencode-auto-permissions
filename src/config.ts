import type { ReviewModel } from "./types.ts"
import { defaultDiagnosticsPath } from "./diagnostics.ts"

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_USER_MESSAGE_COUNT = 4

export interface Config {
  model: ReviewModel
  modelLabel: string
  timeoutMs: number
  userMessageCount: number
  shadow: boolean
  sessionApprovals: boolean
  runtime: "auto" | "stable" | "v2"
  diagnosticsPath: string | undefined
}

export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const modelValue = options.model
  if (typeof modelValue !== "string" || !modelValue.trim()) {
    throw new Error('Auto Permissions requires a "model" option in provider/model form')
  }

  const slash = modelValue.indexOf("/")
  if (slash < 1 || slash === modelValue.length - 1) {
    throw new Error('Auto Permissions model must use "provider/model" form')
  }

  const providerID = modelValue.slice(0, slash).trim()
  const id = modelValue.slice(slash + 1).trim()
  if (!providerID || !id) throw new Error('Auto Permissions model must use "provider/model" form')
  const variant = parseVariant(options.variant)

  return {
    model: { providerID, id, ...(variant ? { variant } : {}) },
    modelLabel: modelValue,
    timeoutMs: boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 30_000, "timeoutMs"),
    userMessageCount: boundedInteger(
      options.userMessageCount,
      DEFAULT_USER_MESSAGE_COUNT,
      1,
      20,
      "userMessageCount",
    ),
    shadow: options.shadow === true,
    sessionApprovals: options.sessionApprovals !== false,
    runtime: parseRuntime(options.runtime),
    diagnosticsPath: parseDiagnosticsPath(options.debug),
  }
}

function parseVariant(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string" && value.trim()) return value.trim()
  throw new Error("Auto Permissions variant must be a non-empty string")
}

function parseDiagnosticsPath(value: unknown): string | undefined {
  if (value === undefined || value === false) return undefined
  if (value === true) return defaultDiagnosticsPath()
  if (typeof value === "string" && value.trim()) return value.trim()
  throw new Error('Auto Permissions debug must be true, false, or a file path')
}

function parseRuntime(value: unknown): Config["runtime"] {
  if (value === undefined) return "auto"
  if (value === "auto" || value === "stable" || value === "v2") return value
  throw new Error('Auto Permissions runtime must be "auto", "stable", or "v2"')
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Auto Permissions ${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value as number
}
