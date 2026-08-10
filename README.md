# OpenCode Auto Permissions

[![release](https://img.shields.io/github/v/release/hueyexe/opencode-auto-permissions.svg)](https://github.com/hueyexe/opencode-auto-permissions/releases)
[![tests](https://img.shields.io/badge/tests-53%20passing-brightgreen.svg)](./test)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)
[![OpenCode](https://img.shields.io/badge/OpenCode-stable%20%2B%20V2-blue.svg)](./docs/COMPATIBILITY_SPIKE.md)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Automatic, model-driven permission review for OpenCode. Routine actions continue quietly, clearly prohibited actions are blocked, and ambiguous requests remain in OpenCode's native permission prompt for you to decide.

The plugin supports stable and V2 OpenCode permission protocols automatically. It never grants permanent `always` permission.

## Quick Start

Add the tagged Git package and a reviewer model to your global OpenCode config at `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    [
      "opencode-auto-permissions@git+https://github.com/hueyexe/opencode-auto-permissions.git#v0.1.0",
      { "model": "openai/gpt-5.6-luna" }
    ]
  ],
  "permission": {
    "bash": "ask",
    "external_directory": "ask"
  }
}
```

Use any configured model in `provider/model` form. Restart OpenCode after changing the config.

V2 users must add the same plugin tuple to `~/.config/opencode/tui.json` so the TUI adapter can resolve V2 permission events:

```json
{
  "plugin": [
    [
      "opencode-auto-permissions@git+https://github.com/hueyexe/opencode-auto-permissions.git#v0.1.0",
      { "model": "openai/gpt-5.6-luna" }
    ]
  ]
}
```

Stable OpenCode does not need the TUI entry. Keep the tag pinned in both files when using V2, and update both entries together.

## How It Works

For each supported permission request, Auto Permissions combines deterministic safety rules with an isolated, one-step reviewer model:

- Explicit user prohibitions are rejected without model review.
- Clearly authorized, routine actions can be approved once.
- Ambiguous requests, reviewer failures, and timeouts fall back to OpenCode's native prompt.
- Reviewer sessions are hidden, have no tools, and deny all permissions.
- Only a small, recent window of relevant user context is sent for review.

The reviewer never receives authority to execute the requested action. It can only recommend a one-time approval, reject the request, or abstain.

## Configuration

The plugin tuple accepts these options:

| Option | Default | Description |
| --- | --- | --- |
| `model` | Required | Reviewer model in `provider/model` form. |
| `timeoutMs` | `8000` | Review timeout from 100 to 30,000 milliseconds. |
| `userMessageCount` | `4` | Recent user messages included in review context, from 1 to 20. |
| `shadow` | `false` | Evaluate and record decisions without replying to permission requests. |
| `runtime` | `"auto"` | Diagnostics override: `"auto"`, `"stable"`, or `"v2"`. Leave this on `"auto"` in normal use. |
| `debug` | `false` | Write the latest 100 privacy-minimized outcomes to a JSONL file. Use `true` for the default path or provide a file path. |

Start with `shadow: true` if you want to observe behavior before enabling automatic replies.

With `debug: true`, diagnostics are written to `$XDG_STATE_HOME/opencode/auto-permissions/decisions.jsonl` (normally `~/.local/state/opencode/auto-permissions/decisions.jsonl`). Records include action type, timing, verdict, reason, reply result, and failure category. Commands, paths, tool inputs, and conversation text are not logged.

## Compatibility

Release `v0.1.0` has been acceptance-tested in the real TUI with:

- OpenCode stable `1.18.12`
- OpenCode V2 `0.0.0-beta-202608040144`

The runtime protocol is detected automatically; stable permission events are handled by the server adapter and V2 events by the TUI adapter. See the [compatibility notes](docs/COMPATIBILITY_SPIKE.md) for implementation evidence and known protocol differences.

## Development

Requires [Bun](https://bun.sh/) and Node.js 22 or later.

```bash
bun install
bun run verify
```

`verify` runs strict TypeScript checks, the test suite, a production build, and package export smoke tests. Isolated runtime launchers are also available:

```bash
bun run test:stable
bun run test:v2
```

The launchers leave normal OpenCode configuration and session data untouched. See [Testing](docs/TESTING.md) for setup and acceptance scenarios.

## License

[MIT](LICENSE)
