# OpenCode Auto Permissions

[![release](https://img.shields.io/github/v/release/hueyexe/opencode-auto-permissions.svg)](https://github.com/hueyexe/opencode-auto-permissions/releases)
[![tests](https://img.shields.io/badge/tests-62%20passing-brightgreen.svg)](./test)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)
[![OpenCode](https://img.shields.io/badge/OpenCode-stable%20%2B%20V2-blue.svg)](./docs/COMPATIBILITY_SPIKE.md)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Automatic, context-aware permission review for OpenCode. Let routine work run normally, send riskier actions to a reviewer model, and keep coding agents moving while you are away.

The plugin supports stable and V2 OpenCode permission protocols automatically. It never grants permanent `always` permission.

## Quick Start

The recommended setup is not to set every permission to `ask`. Allow routine work in OpenCode, then use `ask` for operations where context matters. Only `ask` requests reach Auto Permissions.

Add the tagged Git package, reviewer model, and risk-based permission rules to your global OpenCode config at `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    [
      "opencode-auto-permissions@git+https://github.com/hueyexe/opencode-auto-permissions.git#v0.1.0",
      { "model": "openai/gpt-5.6-luna" }
    ]
  ],
  "permission": {
    "bash": {
      "*": "allow",
      "rm *": "ask",
      "sudo *": "ask",
      "git push *": "ask",
      "git reset --hard*": "ask",
      "git clean -f*": "ask",
      "curl * | *sh*": "ask",
      "wget * | *sh*": "ask"
    },
    "external_directory": "ask",
    "webfetch": "allow",
    "websearch": "allow"
  }
}
```

OpenCode uses the last matching permission rule, so keep the broad `"*": "allow"` rule first and the narrower `ask` rules after it. Adapt the list to your environment: deployments, infrastructure commands, package publication, and production database tools are good candidates for contextual review.

Use any configured model in `provider/model` form. A fast, reliable model that follows JSON instructions works best. Restart OpenCode after changing the config.

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

- OpenCode handles `allow` and `deny` rules before the plugin; Auto Permissions reviews requests configured as `ask`.
- Explicit user prohibitions and clearly catastrophic root/home deletion are rejected without model review.
- Contextual risks such as `sudo`, scoped deletion, force push, deployment, credential access, and external-directory access are judged against the user's request and target scope.
- External-directory boundaries are not treated as sensitive by default: ordinary project, tool, cache, log, state, temporary, and worktree paths are approved unless the target or operation presents a concrete hazard.
- Broad boundary globs such as `/tmp/*` are not treated as the requested scope when the tool input identifies a precise target; the reviewer evaluates the actual operation and latest user request.
- The reviewer is tuned for unattended agents: it defaults to approval when an action reasonably serves the task and uses `ask` only as a last resort.
- Reviewer failures and timeouts safely fall back to OpenCode's native prompt.
- Reviewer sessions are hidden, have no tools, and deny all permissions.
- Only a small, recent window of relevant user context is sent for review.

The reviewer never receives authority to execute the requested action. It can only grant one-time approval, reject the request, or abstain. It never grants permanent `always` permission.

When an action is rejected, Auto Permissions returns the reason to the main agent and asks it to continue with a safer alternative when possible. For example, it can target a generated subdirectory instead of a broad recursive delete, use `--force-with-lease` instead of an unrestricted force push, or inspect a deployment plan before applying it. A denial should redirect useful work rather than end the session.

## Choosing Rules

Use OpenCode's three permission outcomes deliberately:

| Rule | Use it for | Plugin behavior |
| --- | --- | --- |
| `allow` | Routine, expected work that should never wait | OpenCode runs it immediately; the reviewer is not called. |
| `ask` | Risk depends on user intent, target, or scope | Auto Permissions reviews context and replies once. |
| `deny` | Actions that must never run in your environment | OpenCode blocks it immediately; the reviewer cannot override it. |

For unattended multi-agent work, prefer `allow` for ordinary reads, edits, tests, builds, and source-control inspection. Prefer `ask` over `deny` for commands that can be legitimate in the right context. Reserve `deny` for firm organizational or personal boundaries.

Avoid an all-`ask` configuration unless you are evaluating the plugin in `shadow` mode. It adds model latency to every tool call and makes reviewer outages affect routine work.

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

Access to this bounded diagnostics file is deterministically allowed by the plugin so troubleshooting cannot be blocked by speculative sensitivity concerns. This exception applies only to Auto Permissions' own `decisions.jsonl` path.

Reviewer sessions are standalone rather than children of the active coding session. This keeps reviewer model and variant state isolated from the main agent and its displayed reasoning level.

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
