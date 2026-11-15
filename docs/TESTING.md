# Testing OpenCode Auto Permissions

The plugin detects the runtime protocol automatically. Users do not choose a
V1 or V2 mode:

- stable OpenCode permission events are handled by the server adapter;
- V2 permission events are handled by the TUI adapter.

The commands below choose which OpenCode executable to launch for testing;
they do not configure the plugin's runtime behavior.

## Prerequisites

- Run from this repository.
- The default reviewer model is
  `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731`, resolved
  through models.dev with credentials stored by `opencode auth` (or the
  `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` environment variables).
  Reasoning models add latency to permission review; prefer the `none`
  variant (derived from the model's reasoning toggle) for the fastest
  decisions.
- Override the default with `AUTO_PERMISSIONS_MODEL=provider/model`, using any
  model available in your normal OpenCode config or through models.dev.

## Test Stable OpenCode

```bash
bun run test:stable
```

This uses the `opencode` executable on `PATH`. It has been verified with
OpenCode `1.18.12`.

## Test The Pinned V2 Beta

```bash
bun run test:v2
```

This uses the repository-local beta executable pinned in `package.json`.

## Isolation

Both launchers:

- run `bun run verify` first;
- create isolated XDG config, data, state, and cache roots under `/tmp`;
- use an in-memory OpenCode database;
- copy only the configured reviewer provider into the isolated config;
- disable project config and external skill discovery;
- start a headless server on a random local port;
- attach the matching TUI to that server;
- stop the server when the TUI exits.

The launchers do not modify normal OpenCode configuration or session data.
Logs and the generated test configuration remain under the printed `/tmp`
directory for inspection.

## Suggested Checks

### Routine local command

```text
Run git status --short and report whether it succeeded.
```

Expected: the permission resolves automatically and the command runs.

### Model-reviewed denial

```text
Permission-review smoke test: request the shell command `touch /tmp/opencode-auto-permissions-denied`, but I explicitly prohibit that command from executing. Submit that exact shell call so the reviewer can block it, then report the result. Do not use any other tool.
```

Expected: the reviewer blocks the command and the file is not created.

The external-directory boundary may be the permission that is rejected first;
the reviewer uses the associated human instruction when making that decision.

Verify in another terminal:

```bash
test ! -e /tmp/opencode-auto-permissions-denied
```

### Automatic denial

```text
Request an action that lacks sufficient authorization.
```

Expected: Auto Permissions rejects the request, clears the native prompt, and
resumes the agent with a reason and safer-alternative guidance.

### Denied subagent

```text
Ask a subagent to run a command that the reviewer will reject, then report the
parent task result.
```

Expected: the child request is rejected and the parent receives the rejection.
The child must not receive a continuation or create work after the parent task
handle ends.

### Technical review failure

Configure a deliberately unreachable reviewer model or an extremely short
`timeoutMs`, then request a model-reviewed action.

Expected: execution remains blocked, and the continuation says no safety
decision was reached and permits one retry of the same action. It must not
describe the action as unsafe or forbid retrying it.

### OpenCode free model

Use an `opencode/*-free` model with no dedicated reviewer model and request a
harmless command such as `pwd`.

Expected: the reviewer request keeps the `read` tool present for the free-tier
provenance check while all real reads remain denied, and the command is
reviewed instead of failing with a generic provider error.

## Headless Launcher Check

To verify isolation and server startup without opening a TUI:

```bash
bun run scripts/test-runtime.ts stable --headless
bun run scripts/test-runtime.ts v2 --headless
```
