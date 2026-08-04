import type { Decision, ReviewInput } from "./types.ts"

const SENSITIVE_PATH = /(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|Keychains?|credentials?|tokens?)(?:[\\/]|$)|(?:^|[\\/])\.env(?:\.|$)/i
const SHELL_COMPOSITION = /[;&|<>`\n]|\$\(|<\(|>\(/

export function applyDeterministicPolicy(input: ReviewInput): Decision | null {
  const { action, resources } = input.request
  if (action === "external_directory" && resources.some((resource) => SENSITIVE_PATH.test(resource))) {
    return deny("sensitive_external_directory", "Targets a credential or secret directory.")
  }

  if (action !== "shell" && action !== "bash") return null
  const command = commandText(input)
  if (!command) return null

  if (/(?:^|\s)sudo(?:\s|$)/.test(command)) {
    return deny("privilege_escalation", "Uses sudo to elevate privileges.")
  }
  if (/\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/i.test(command)) {
    return deny("download_and_execute", "Downloads content and executes it as shell code.")
  }
  if (/\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f)(?:\s|$)/i.test(command)) {
    return deny("force_push", "Rewrites remote Git history.")
  }
  if (/\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f)/i.test(command)) {
    return deny("destructive_git", "Can discard uncommitted work.")
  }
  if (SENSITIVE_PATH.test(command)) {
    return deny("credential_access", "Accesses a path commonly used for credentials or secrets.")
  }
  if (isRootOrHomeRecursiveDelete(command)) {
    return deny("destructive_delete", "Recursively deletes the filesystem root or home directory.")
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
