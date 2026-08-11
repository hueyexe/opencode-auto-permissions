# Testing OpenCode Auto Permissions

The plugin detects the runtime protocol automatically. Users do not choose a
V1 or V2 mode:

- stable OpenCode permission events are handled by the server adapter;
- V2 permission events are handled by the TUI adapter.

The commands below choose which OpenCode executable to launch for testing;
they do not configure the plugin's runtime behavior.

## Prerequisites

- Run from this repository.
- Configure the selected reviewer model in your normal OpenCode config.
- Override the default model with `AUTO_PERMISSIONS_MODEL=provider/model` if
  required. The default is `openai/gpt-5.6-luna`.

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

## Headless Launcher Check

To verify isolation and server startup without opening a TUI:

```bash
bun run scripts/test-runtime.ts stable --headless
bun run scripts/test-runtime.ts v2 --headless
```
