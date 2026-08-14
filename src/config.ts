import type { ReviewModel } from "./types.ts"
import { defaultDiagnosticsPath } from "./diagnostics.ts"

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_USER_MESSAGE_COUNT = 8

export interface Config {
  model: ReviewModel | undefined
  modelLabel: string | undefined
  variant: string | undefined
  timeoutMs: number
  userMessageCount: number
  shadow: boolean
  sessionApprovals: boolean
  runtime: "auto" | "stable" | "v2"
  diagnosticsPath: string | undefined
}

export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const modelValue = options.model
  const variant = parseVariant(options.variant)
  const model = parseModel(modelValue, variant)

  return {
    model,
    modelLabel: typeof modelValue === "string" ? modelValue : undefined,
    variant,
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

function parseModel(value: unknown, variant: string | undefined): ReviewModel | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) {
    throw new Error('Auto Permissions model must use "provider/model" form')
  }
  const slash = value.indexOf("/")
  if (slash < 1 || slash === value.length - 1) {
    throw new Error('Auto Permissions model must use "provider/model" form')
  }
  const providerID = value.slice(0, slash).trim()
  const id = value.slice(slash + 1).trim()
  if (!providerID || !id) throw new Error('Auto Permissions model must use "provider/model" form')
  return { providerID, id, ...(variant ? { variant } : {}) }
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
