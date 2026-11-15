# OpenCode Auto Permissions

[![release](https://img.shields.io/github/v/release/hueyexe/opencode-auto-permissions.svg)](https://github.com/hueyexe/opencode-auto-permissions/releases)
[![npm](https://img.shields.io/npm/v/opencode-auto-permissions.svg)](https://www.npmjs.com/package/opencode-auto-permissions)
[![tests](https://img.shields.io/badge/tests-129%20passing-brightgreen.svg)](./test)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)
[![OpenCode](https://img.shields.io/badge/OpenCode-stable%20%2B%20V2-blue.svg)](./docs/COMPATIBILITY_SPIKE.md)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Automatic, context-aware permission review for OpenCode. Let routine work run normally, send riskier actions to a reviewer model, and keep coding agents moving while you are away.

The plugin supports stable and V2 OpenCode permission protocols automatically. It never grants permanent `always` permission.

## Install

Install the published npm package globally with OpenCode's built-in plugin installer:

```bash
opencode plugin add opencode-auto-permissions
```

Older stable builds use `opencode plugin -g opencode-auto-permissions` instead.

That is the complete plugin installation. You do not need to clone this repository, install Bun, run `npm install`, choose a reviewer model, or edit plugin entries manually.

OpenCode downloads the package, detects its separate server and TUI targets, and registers `opencode-auto-permissions` in your global plugin configuration (`~/.config/opencode/opencode.json` on current builds; older V2 betas also added a TUI entry to `~/.config/opencode/cli.json`).

Quit and restart OpenCode after installation because configuration is loaded at startup. Auto Permissions automatically uses the model and variant selected by the session that requested the action. Current V2 builds review permissions on the server, so local, remote, web, and multiple simultaneous clients share one reviewer. Older runtimes fall back to the TUI integration; the two paths coordinate so only one reviewer handles each request.

## Configure Permissions

The recommended setup is not to set every permission to `ask`. Allow routine work in OpenCode, then use `ask` for operations where context matters. Only `ask` requests reach Auto Permissions. For example, add risk-based rules to `~/.config/opencode/opencode.json`:

```json
{
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

To confirm installation, restart OpenCode and inspect both global files for the package entry. Actions resolved by `allow` or `deny` rules will not invoke the plugin; use an `ask` rule to exercise automatic review.

## Update

Update the package plugin to the latest published version:

```bash
opencode plugin update opencode-auto-permissions
```

If your configuration entry pins a version (for example `opencode-auto-permissions@0.2.10`), remove the pin or repoint it first; the updater treats a satisfied version pin as current. Older stable builds use `opencode plugin -g --force opencode-auto-permissions@latest` instead.

Restart OpenCode after updating. If you use an advanced options tuple, confirm that the server and TUI entries still contain the same options after the update.

## Uninstall

Remove `opencode-auto-permissions` with `opencode plugin remove opencode-auto-permissions`, or remove its entry from the plugin array in `~/.config/opencode/opencode.json` (and from `~/.config/opencode/cli.json` on older V2 betas), then restart OpenCode.

Remove only this package's entries; leave other plugins and configuration unchanged.

## How It Works

For each supported permission request, Auto Permissions combines deterministic safety rules with an isolated, one-step reviewer model:

- OpenCode handles `allow` and `deny` rules before the plugin; Auto Permissions reviews requests configured as `ask`.
- Explicit user prohibitions and clearly catastrophic root/home deletion are rejected without model review.
- Contextual risks such as `sudo`, scoped deletion, force push, deployment, credential access, and external-directory access are judged against the user's request and target scope.
- External-directory boundaries are not treated as sensitive by default: ordinary project, tool, cache, log, state, temporary, and worktree paths are approved unless the target or operation presents a concrete hazard.
- Broad boundary globs such as `/tmp/*` are not treated as the requested scope when the tool input identifies a precise target; the reviewer evaluates the actual operation and latest user request.
- The reviewer is tuned for unattended agents: it defaults to approval when an action reasonably serves the task and uses `ask` only as a last resort.
- If a dedicated reviewer model times out, errors, or returns an invalid decision, the plugin tries the requesting session's model once, preserving that session model's variant. It does not retry the same provider/model, and a valid denial never triggers fallback.
- If no fallback is available or both attempts fail, the request is rejected automatically. The main agent is told that no safety decision was reached, that execution remains blocked, and that it may retry the same action once so a fresh review can run. A technical failure is never presented as a safety denial.
- Reviewer sessions are hidden and cannot execute real tools. They deny all permissions, except that OpenCode free-tier models keep an unreachable `read` allow rule because the free-tier gateway rejects requests that omit the read tool.
- Denial continuations are only delivered to resolved root sessions. A denied subagent stays terminated instead of being resumed after its parent task handle has already ended; unknown parentage also fails closed.
- Only a small, recent window of relevant user context is sent for review.
- Plugin-authored denial continuations are excluded from that context so an earlier verdict cannot become a self-reinforcing human instruction.

The reviewer never receives authority to execute the requested action. It always resolves the request by approving once, approving narrow matching requests for the current session, or rejecting with an actionable reason. Session approvals are held in memory by OpenCode and do not persist to later sessions.

Reviewer sessions are standalone and deleted after each decision or failure. Startup never deletes reviewer sessions because multiple OpenCode processes may be reviewing permissions concurrently; one process must not delete another process's active review.

Auto Permissions never asks the user to resolve a permission prompt. When the reviewer cannot safely approve, it denies and tells the coding agent why, what safer alternative to try, and to continue autonomously where possible.

Denial and failure continuations preserve the main session's selected agent, model, and variant. A permission decision does not reset the primary agent's reasoning effort.

### Session Approvals

For repeatable low-risk operations, the reviewer may choose `allow_session`. The plugin then uses OpenCode's own tool-provided `always` patterns, so future matching requests in that session bypass another model call. It never invents or broadens a permission pattern.

Code-side guardrails downgrade `allow_session` to a one-time approval when patterns are missing or broad, or when the action involves edits, external-directory boundaries, `sudo`, deletion, push, publish, deploy, credentials, destructive Git, or other non-repeatable effects. Eligible examples include narrow reads/searches and commands such as a specific `git fetch` or test invocation. Set `sessionApprovals: false` to force all model approvals to remain one-time.

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
| `model` | Requesting session model | Optional dedicated reviewer model in `provider/model` form. |
| `variant` | Selected model's default | Optional reviewer-only model variant. Use `"low"` when supported for faster decisions. |
| `sessionApprovals` | `true` | Reuse guarded, pattern-specific approvals immediately for the current session. Set `false` for one-time approvals only. |
| `timeoutMs` | `30000` | Per-model timeout from 100 to 300,000 milliseconds. A fallback gets its own budget, so two model attempts can take up to 10 minutes at the maximum (plus context/reply overhead). Raise this for slow local models. |
| `userMessageCount` | `8` | Recent user messages included in review context, from 1 to 20. |
| `shadow` | `false` | Evaluate and record decisions without replying to permission requests. |
| `runtime` | `"auto"` | Diagnostics override: `"auto"`, `"stable"`, or `"v2"`. Leave this on `"auto"` in normal use. |
| `debug` | `false` | Write the latest 100 privacy-minimized outcomes to a JSONL file. Use `true` for the default path or provide a file path. |

Start with `shadow: true` if you want to observe behavior before enabling automatic replies. Because options are an advanced manual configuration, edit both generated entries so the server and TUI receive identical settings.

No configuration tuple is required. To override the automatic session-model selection with a dedicated reviewer model, or to use other advanced options, replace the package string in both generated plugin entries with the same options tuple:

```json
[
  "opencode-auto-permissions",
  { "model": "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", "variant": "none" }
]
```

Keep the entries in `~/.config/opencode/opencode.json` and, on older V2 betas that use it, `~/.config/opencode/cli.json` synchronized. A fast, reliable model that follows JSON instructions works best; deep reasoning adds unnecessary latency for permission review. Restart OpenCode after changing either file.

With `debug: true`, diagnostics are written to `$XDG_STATE_HOME/opencode/auto-permissions/decisions.jsonl` (normally `~/.local/state/opencode/auto-permissions/decisions.jsonl`). Records include action type, timing, verdict, reason, reply result, and failure category. Commands, paths, tool inputs, and conversation text are not logged.

Access to this bounded diagnostics file is deterministically allowed by the plugin so troubleshooting cannot be blocked by speculative sensitivity concerns. This exception applies only to Auto Permissions' own `decisions.jsonl` path.

Reviewer sessions are standalone rather than children of the active coding session. This keeps reviewer model and variant state isolated from the main agent and its displayed reasoning level.

Concurrent identical requests share one model review. Once a narrow, non-sensitive session pattern is approved, later matching requests in the same root session are approved without another model call. Destructive operations, pushes, publishing, deployments, credential access, and broad wildcard patterns remain one-time decisions.

The plugin does not force a universal reasoning level because variant names differ by provider. Omitting `variant` uses the selected model's variant. Avoid high or maximum reasoning for permission review unless your policy requires unusually complex analysis.

## Compatibility

The compatibility baseline was acceptance-tested in the real TUI with:

- OpenCode stable `1.18.12`
- OpenCode V2 `0.0.0-beta-202608110357`
- OpenCode V2 `2.3.0` (server-side review, multi-client deduplication, and fail-closed paths)

Newer V2 builds (September 2026 and later) renamed the permission event payloads (`permission.v2.asked` back to `permission.asked`, and the reusable-pattern field from `always` to `save`); the plugin accepts both shapes. Current V2 builds review permissions on the server; older V2 betas and stable runtimes use the TUI or stable adapter. See the [compatibility notes](docs/COMPATIBILITY_SPIKE.md) for implementation evidence and known protocol differences.

## Development

This section is only for contributors. Users installing through `opencode plugin` do not need Bun or a repository checkout.

Development requires [Bun](https://bun.sh/) and Node.js 22 or later:

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

Contributions go through pull requests with prefixed branches. See [Contributing](CONTRIBUTING.md).

## License

[MIT](LICENSE)
