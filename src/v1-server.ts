import type { PluginModule } from "@opencode-ai/plugin/v1"
import serverPlugin from "./server.ts"

// The ./server entry is resolved by both runtimes:
// - v1 validates the default export and rejects any `tui` key ("has invalid
//   tui export"), but tolerates extra keys like `setup`.
// - v2 requires `setup` (or `effect`) on every module it loads, including
//   this subpath.
// So expose the shared { id, setup, server } shape and strip only the
// v2-only `tui` capability flag.
const { tui: _tuiCapability, ...dualPlugin } = serverPlugin as typeof serverPlugin & {
  tui?: unknown
}

const v1Plugin = {
  ...dualPlugin,
} satisfies PluginModule

export default v1Plugin
