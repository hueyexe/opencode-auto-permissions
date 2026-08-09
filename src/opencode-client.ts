import type { ReviewModel, ReviewerClient } from "./types.ts"
import { DECISION_SCHEMA, REVIEWER_AGENT_ID } from "./agent.ts"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REVIEWER_PERMISSIONS = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "StructuredOutput", pattern: "*", action: "allow" },
] as const
const REVIEWER_DIRECTORY = join(tmpdir(), "opencode-auto-permissions", "reviewer")

export class OpenCodeClientAdapter implements ReviewerClient {
  constructor(private readonly client: any) {}

  async prewarm(): Promise<void> {
    await mkdir(REVIEWER_DIRECTORY, { recursive: true })
    const location = { directory: REVIEWER_DIRECTORY }
    const requests: Promise<unknown>[] = []
    if (typeof this.client.app?.agents === "function") requests.push(this.client.app.agents(location))
    if (typeof this.client.app?.skills === "function") requests.push(this.client.app.skills(location))
    if (typeof this.client.v2?.agent?.list === "function") {
      requests.push(this.client.v2.agent.list({ location }))
    }
    if (typeof this.client.v2?.skill?.list === "function") {
      requests.push(this.client.v2.skill.list({ location }))
    }
    if (requests.length === 0) throw new Error("OpenCode reviewer prewarm APIs are unavailable")
    await Promise.all(requests)
  }

  async generate(input: {
    prompt: string
    model: ReviewModel
    parentSessionID: string
    location?: { directory?: string; workspaceID?: string }
    signal: AbortSignal
  }): Promise<unknown> {
    const stable = typeof this.client.postSessionIdPermissionsPermissionId === "function"
    const session = stable ? this.client.session : (this.client.v2?.session ?? this.client.session)
    if (!session || typeof session.create !== "function" || typeof session.prompt !== "function") {
      throw new Error("OpenCode reviewer session API is unavailable")
    }

    await mkdir(REVIEWER_DIRECTORY, { recursive: true })
    const location = { directory: REVIEWER_DIRECTORY }
    let sessionID: string | undefined
    const abortRemote = () => {
      if (!sessionID || typeof session.abort !== "function") return
      const abortInput = stable
        ? { path: { id: sessionID }, query: location }
        : { sessionID, ...location }
      void Promise.resolve(session.abort(abortInput)).catch(() => undefined)
    }
    input.signal.addEventListener("abort", abortRemote, { once: true })

    try {
      if (input.signal.aborted) throw abortError(input.signal.reason)
      const createInput = stable
        ? {
            query: location,
            body: { parentID: input.parentSessionID, title: "Auto Permissions review" },
          }
        : {
            ...location,
            parentID: input.parentSessionID,
            title: "Auto Permissions review",
            agent: REVIEWER_AGENT_ID,
            model: input.model,
            metadata: { source: "opencode-auto-permissions" },
            permission: REVIEWER_PERMISSIONS,
          }
      const created = unwrapData(await session.create(createInput, { signal: input.signal }))
      if (!isRecord(created) || typeof created.id !== "string") {
        throw new Error("OpenCode failed to create a reviewer session")
      }
      sessionID = created.id

      const promptBody = {
        model: { providerID: input.model.providerID, modelID: input.model.id },
        variant: input.model.variant,
        agent: REVIEWER_AGENT_ID,
        format: {
          type: "json_schema",
          schema: DECISION_SCHEMA,
          retryCount: 1,
        },
        parts: [{ type: "text", text: input.prompt }],
      }
      const promptInput = stable
        ? { path: { id: sessionID }, query: location, body: promptBody }
        : {
            sessionID,
            ...location,
            ...promptBody,
          }
      const result = unwrapData(await session.prompt(promptInput, { signal: input.signal }))
      return assistantStructured(result)
    } finally {
      input.signal.removeEventListener("abort", abortRemote)
      if (sessionID && typeof session.delete === "function") {
        const deleteInput = stable
          ? { path: { id: sessionID }, query: location }
          : { sessionID, ...location }
        await Promise.resolve(session.delete(deleteInput)).catch(() => undefined)
      }
    }
  }

  async reply(input: {
    sessionID: string
    requestID: string
    reply: "once" | "reject"
    message?: string
    protocol: "stable" | "v2"
  }): Promise<"replied" | "not_found"> {
    try {
      const scoped = this.client.v2?.session?.permission ?? this.client.session?.permission
      if (input.protocol === "v2" && typeof scoped?.reply === "function") {
        try {
          const result = await scoped.reply(input)
          throwForResultError(result)
          return "replied"
        } catch (error) {
          if (!isNotFound(error) || typeof this.client.permission?.reply !== "function") throw error
        }
      }

      const legacy = this.client.permission
      const result = typeof legacy?.reply === "function"
        ? await legacy.reply(input)
        : typeof this.client.postSessionIdPermissionsPermissionId === "function"
          ? await this.client.postSessionIdPermissionsPermissionId({
              path: { id: input.sessionID, permissionID: input.requestID },
              body: { response: input.reply },
            })
          : (() => { throw new Error("OpenCode permission reply API is unavailable") })()
      throwForResultError(result)
      return "replied"
    } catch (error) {
      if (isNotFound(error)) return "not_found"
      throw error
    }
  }
}

function assistantStructured(value: unknown): unknown {
  if (!isRecord(value)) throw new Error("OpenCode reviewer returned an invalid response")
  if (isRecord(value.info) && value.info.error) throw value.info.error
  if (!isRecord(value.info) || !("structured" in value.info)) {
    throw new Error("OpenCode reviewer returned no structured output")
  }
  return value.info.structured
}

function unwrapData(result: unknown): unknown {
  throwForResultError(result)
  let value = result
  for (let depth = 0; depth < 3; depth++) {
    if (!isRecord(value) || !("data" in value)) break
    value = value.data
  }
  return value
}

function throwForResultError(result: unknown): void {
  if (!isRecord(result) || !("error" in result) || result.error === undefined) return
  throw result.error
}

function isNotFound(error: unknown): boolean {
  if (!isRecord(error)) return false
  const status = error.status ?? Reflect.get(error, "statusCode")
  if (status === 404) return true
  const tag = error._tag ?? error.name
  return tag === "PermissionNotFoundError" || tag === "Permission.NotFoundError"
}

function abortError(reason: unknown): Error {
  return new DOMException(typeof reason === "string" ? reason : "Review aborted", "AbortError")
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
