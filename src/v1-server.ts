import type { PluginModule } from "@opencode-ai/plugin/v1"
import { legacyPlugin } from "./server.ts"

const v1Plugin = {
  id: "opencode.auto-permissions.server",
  server: legacyPlugin,
} satisfies PluginModule

export default v1Plugin