import type { Decision, ReviewInput } from "./types.ts"

const SHELL_COMPOSITION = /[;&|<>`\n]|\$\(|<\(|>\(/

export function applyDeterministicPolicy(input: ReviewInput): Decision | null {
  const { action, resources } = input.request
  if (explicitlyProhibited(input)) {
    return deny("explicit_user_prohibition", "The user explicitly prohibited this action.")
  }
  if (action !== "shell" && action !== "bash") return null
  const command = commandText(input)
  if (!command) return null

  if (isRootOrHomeRecursiveDelete(command)) {
    return deny(
      "catastrophic_delete",
      "Recursively deleting the filesystem root or home directory would cause catastrophic data loss; target only the specific generated directory instead.",
    )
  }

  if (!SHELL_COMPOSITION.test(command) && isRoutineLocalCommand(command)) {
    return {
      kind: "allow",
      reasonCode: "routine_local_command",
      reason: "Runs a routine local inspection or validation command.",
    }
  }

  return null
}

function explicitlyProhibited(input: ReviewInput): boolean {
  const message = input.context.userMessages.at(-1)
  if (!message || !/\b(?:explicitly prohibit|do not (?:run|execute|use|access)|must not (?:run|execute|use|access))\b/i.test(message)) {
    return false
  }

  const command = commandText(input)
  if ((input.request.action === "shell" || input.request.action === "bash") && command && message.includes(command)) {
    return true
  }

  if (input.request.action !== "external_directory") return false
  return input.request.resources.some((resource) => {
    const prefix = resource.replace(/[?*].*$/, "")
    return prefix.length > 1 && message.includes(prefix)
  })
}

function deny(reasonCode: string, reason: string): Decision {
  return { kind: "deny", reasonCode, reason }
}

function commandText(input: ReviewInput): string {
  const toolInput = input.request.toolInput
  if (typeof toolInput === "object" && toolInput !== null && "command" in toolInput) {
    const command = Reflect.get(toolInput, "command")
    if (typeof command === "string") return command.trim()
  }
  return input.request.resources.join(" && ").trim()
}

function isRootOrHomeRecursiveDelete(command: string): boolean {
  return /(?:^|\s)rm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+(?:--\s+)?(?:["']?\/["']?|["']?~["']?|["']?\$HOME["']?)(?:\s|$)/i.test(
    command,
  )
}

function isRoutineLocalCommand(command: string): boolean {
  const value = command.trim()
  return [
    /^git\s+(?:status|diff|log|show)(?:\s|$)/,
    /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|build|typecheck|check))(?:\s|$)/,
    /^(?:bun|pnpm|yarn)\s+run\s+(?:test|lint|build|typecheck|check)(?:\s|$)/,
    /^cargo\s+(?:test|check|build)(?:\s|$)/,
    /^go\s+test(?:\s|$)/,
    /^(?:pytest|ruff\s+check|tsc)(?:\s|$)/,
  ].some((pattern) => pattern.test(value))
}
