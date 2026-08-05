# OpenCode Auto Permissions Build Plan

## 1. Product Goal

Build an OpenCode-only plugin that delegates permission decisions to a
user-selected model without making the user babysit routine commands.

The product contract is:

1. Install once.
2. Select any text-capable model available through OpenCode.
3. Restart OpenCode.
4. Routine work proceeds without user interaction.
5. Clearly unsafe work is blocked automatically with corrective feedback.
6. Ambiguous work keeps OpenCode's native approval prompt.
7. Reviewer failures always fall back to manual approval.

GPT-5.6 Luna is the development and initial evaluation model. It must not be
hard-coded as a runtime default, fallback, or provider dependency.

## 2. Scope

### Initial release

- Stable OpenCode interactive TUI, verified on `1.18.12`.
- OpenCode V2 beta interactive TUI through its V2 TUI plugin adapter.
- Shell permissions.
- External-directory permissions.
- Explicit user boundaries from recent conversation context.
- Deterministic hard policy before model review.
- Quiet status indicator, concise block/manual-review feedback, and local
  decision history.
- Git-backed installation from this repository.

### Not in the initial release

- Headless automatic review for `opencode run`.
- Desktop or web clients without a verified permission-event integration.
- MCP-specific policy beyond permissions OpenCode already surfaces.
- Production deploy authorization or organization policy management.
- Persistent learning from prior sessions.
- Telemetry.

Headless use must fail closed: the installed OpenCode permission rules still
produce `ask`, and without a verified reviewer adapter no action is
auto-approved.

## 3. UX Contract

### Idle

Show one quiet footer item:

```text
Auto Permissions · GPT-5.6 Luna
```

Use the configured model's display name. Do not show approval notifications,
success toasts, countdowns, or transcript messages.

### Reviewing

Do not render transient feedback for reviews completed within 200 ms. For a
slower review, change the footer item temporarily:

```text
Reviewing · shell
```

The native permission card may briefly appear because V2 publishes
`permission.asked` before plugins can respond. Fast static rules and a warm,
compact reviewer request should make this uncommon and short-lived.

### Allowed

- Reply `once`.
- Remove the native prompt by resolving it.
- Continue silently.
- Record the decision in in-memory history.
- Never use `always` on the user's behalf.

### Blocked

- Reply `reject` with a short corrective message for the primary agent.
- Show one short TUI toast, for example:

```text
Blocked · Conflicts with your instruction not to push.
```

- Do not notify the desktop unless a human response is required.
- Stop equivalent retry loops after three automatic blocks in one turn.

### Manual approval

- Send no permission reply, leaving OpenCode's native prompt active.
- Show one concise reason:

```text
Manual approval · Adds an unrequested dependency.
```

- Notify through OpenCode's attention API only when the terminal is unfocused.

### Degraded

On timeout, invalid output, missing model, provider failure, or an internal
plugin error:

```text
Auto Permissions unavailable · Manual approval required
```

Rate-limit this feedback. Never turn a reviewer failure into an approval.

### Transparency

Add command-palette actions:

- `Auto Permissions: History`
- `Auto Permissions: Diagnostics`
- `Auto Permissions: Shadow mode`

History is session-local and redacted. Diagnostics shows plugin version,
OpenCode version, selected model, compatibility status, latency summary, and
the last failure without exposing secrets.

## 4. Installation And Distribution

### Decision

Use OpenCode's Git-backed package installation, following the same broad
approach as `obra/superpowers`:

```text
Fetch and follow instructions from https://raw.githubusercontent.com/hueyexe/opencode-auto-permissions/refs/heads/main/INSTALL.md
```

The installer is an agent-readable document, not an executable remote shell
script. It must explain every file it changes and preserve unrelated config.

### Why Git first

- It is already supported by OpenCode's Bun-backed package resolver.
- Users do not need npm credentials or a global package install.
- A tag can pin an immutable reviewed version.
- The same package exposes a stable/server entrypoint and a V2 TUI entrypoint.
- It avoids introducing a second distribution channel before the V2 API is
  stable.

### Configuration written by the installer

The installer asks for one required value: an exact OpenCode model reference
in `provider/model` form. It validates that reference against OpenCode's model
catalog before writing config.

For stable OpenCode, the installer adds the package and model option to the
normal `plugin` configuration. For V2, it additionally adds the tagged Git
package to V2's TUI config at
`~/.config/opencode/cli.json`:

```json
{
  "plugins": [
    {
      "package": "opencode-auto-permissions@git+https://github.com/hueyexe/opencode-auto-permissions.git#v0.1.0",
      "options": {
        "model": "provider/model-id"
      }
    }
  ]
}
```

It also establishes the minimum review boundary in the global OpenCode config
at `~/.config/opencode/opencode.json`:

```json
{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "external_directory", "resource": "*", "effect": "ask" }
  ]
}
```

Those broad review rules are inserted before existing user-authored rules so
later explicit `allow` and `deny` entries remain authoritative. This also makes
the boundary apply to custom agents without relying on plugin transform order.

The installer must:

1. Detect and verify an explicitly supported OpenCode runtime version.
2. Refuse to overwrite malformed config.
3. Preserve comments and unrelated fields where JSONC is in use.
4. Avoid duplicate package entries and permission rules.
5. Show an exact before/after summary.
6. Tell the user to restart OpenCode.
7. Provide matching update and uninstall instructions.

### Development install

Development may point `cli.json` at a local checkout or an exact commit. Never
recommend an unpinned mutable branch as the stable installation path.

### npm

Do not publish to npm for the first beta. Reconsider npm after the V2 plugin
and permission schemas stabilize and at least one tagged Git release has been
used successfully across Linux, macOS, and Windows.

## 5. Git Tags And GitHub Releases

Git tags and GitHub Releases serve different purposes.

### Git tags are required

Tags are part of the installation mechanism. Stable installs pin a SemVer tag:

```text
#v0.1.0
```

Use prerelease tags such as `v0.1.0-beta.1` during field testing. Do not move or
replace a published tag.

### GitHub Releases are recommended, not required for execution

The plugin does not download release assets. A GitHub Release should point at
the corresponding tag and provide:

- human-readable changes;
- supported OpenCode versions;
- migration notes;
- known limitations;
- checksum-free provenance through the immutable Git tag.

No binary archives or generated assets are needed initially. GitHub Releases
also provide a reliable latest-stable source for the installer and make update
discovery easier.

### Release channels

- `main`: releasable source; not the stable install target.
- `vX.Y.Z-beta.N`: prerelease field tests.
- `vX.Y.Z`: stable Git install target.

The `INSTALL.md` on `main` must always reference the latest stable tag, not
`main` itself. Updating is rerunning the same install prompt, reviewing the
version change, and restarting OpenCode.

## 6. Runtime Architecture

### Package shape

```text
opencode-auto-permissions/
  src/
    tui.tsx
    config.ts
    review.ts
    context.ts
    policy.ts
    prompt.ts
    verdict.ts
    history.ts
    redact.ts
    ui.tsx
  test/
    unit/
    integration/
    fixtures/
  evals/
    cases.jsonl
    run.ts
  dist/
    tui.js
  docs/
    BUILD_PLAN.md
    SECURITY.md
  INSTALL.md
  CHANGELOG.md
  package.json
```

Start with this flat module layout. Split modules further only when a concrete
reuse or complexity boundary appears.

The package exports server and TUI adapters:

```json
{
  "name": "opencode-auto-permissions",
  "type": "module",
  "exports": {
    ".": "./dist/server.js",
    "./server": "./dist/server.js",
    "./tui": "./dist/tui.js"
  }
}
```

The tagged commit contains the built `dist/server.js` and `dist/tui.js`; installation must not
depend on a development toolchain running successfully on the user's machine.
CI verifies that `dist` exactly matches source.

### Runtime adapters

Stable OpenCode is handled by the server adapter using stable
`permission.asked`/`permission.updated` events and the stable reply endpoint.
V2 is handled by the TUI adapter using `permission.v2.asked` and the
session-scoped V2 reply endpoint. Runtime ownership is selected automatically
from the OpenCode version; users do not select a mode.

Both adapters normalize into one reviewer pipeline and use the same hidden,
deny-all reviewer agent.

### Shared state

Keep runtime state in memory:

- request IDs currently being reviewed;
- one `AbortController` per request;
- recent redacted decisions;
- equivalent-denial counters per turn;
- latency samples;
- current footer status;
- one-shot warnings and failure cooldowns.

Nothing is persisted in the first release except plugin configuration.

## 7. Permission Review Pipeline

For every supported stable or V2 permission event:

1. Validate the event schema.
2. Deduplicate by request ID.
3. Register cancellation before starting asynchronous work.
4. Resolve the root session through OpenCode's session lineage.
5. Resolve the exact tool call through `source.messageID` and `source.callID`.
6. Collect only relevant recent human messages from the root session.
7. Apply deterministic policy.
8. If policy abstains, create an isolated hidden reviewer session and invoke
   the configured model with OpenCode's `json_schema` output format.
9. Validate only `info.structured`; never parse fallback text.
10. Recheck that the request is still pending.
11. Reply `once`, reply `reject` with corrective feedback, or abstain.
12. Record a redacted decision and latency.

Subscribe to `permission.replied` before processing asks. Any reply from the
user, OpenCode, or another client cancels the matching in-flight review. A
reply API `404` is a benign lost race.

### Internal decision type

```ts
type Decision =
  | { kind: "allow"; reasonCode: string; reason: string }
  | { kind: "deny"; reasonCode: string; reason: string }
  | { kind: "ask"; reasonCode: string; reason: string }
```

No numeric confidence score is used. Uncertainty is represented by `ask`.

## 8. Deterministic Policy

The model is not the only policy layer. Deterministic checks run first and
cannot be weakened by model output.

### Immediate deny candidates

- Recursive deletion of filesystem root or home.
- Credential and secret stores such as SSH keys, cloud credentials, shell
  history, keychains, and known token stores.
- Privilege escalation and persistent system service modification.
- Download-and-execute pipelines.
- Obvious credential exfiltration.
- Force pushes, destructive branch deletion, and destructive Git cleanup.
- Attempts to alter Auto Permissions' configuration, package, decision
  history, or reviewer process without an explicit user request.
- Actions that directly contradict an explicit current-session boundary.

### Immediate allow candidates

Keep this set intentionally narrow:

- Exact read-only repository status commands.
- Exact build/test/lint/typecheck commands with no shell composition,
  redirection, substitution, or external destination.
- Other cases added only after evaluation demonstrates negligible false-allow
  risk.

Everything else goes to the configured model or remains manual. Static
OpenCode `deny` rules resolve before the plugin sees an event and are always
authoritative.

## 9. Model Review

### Model independence

Accept an exact OpenCode model reference and resolve it through the current
model catalog. Do not contain provider-specific SDK calls, API keys, model
aliases, pricing assumptions, or fallback models.

The configured model must support ordinary text generation. Models that fail
strict output validation simply cause manual approval.

### Isolated structured request

The published V2 beta does not register its stateless generation endpoint, so
the compatibility layer creates a short-lived hidden reviewer session in a
plugin-owned temporary location. The session denies every ordinary tool,
re-allows only OpenCode's synthetic `StructuredOutput` tool, replaces assembled
system context with the fixed reviewer policy, and is deleted in `finally`.

The prompt contains:

1. A fixed reviewer policy controlled by this package.
2. An explicit statement that all following fields are untrusted data.
3. A JSON-serialized request containing the exact action, all resources, exact
   tool input, working location, relevant human messages, and prior explicit
   human decisions when provenance is certain.
4. A JSON Schema output contract supplied through OpenCode's structured-output
   API, not repeated in prompt prose.

Expected output:

```json
{
  "decision": "allow",
  "reasonCode": "local_test_command",
  "reason": "Runs the project's local test suite."
}
```

Reject markdown fences, preambles, duplicate/conflicting decisions, unknown
keys, invalid reason codes, oversized reasons, and any decision other than
`allow`, `deny`, or `ask`.

### Runtime limits

- Current compatibility timeout: 8 seconds, covering measured cold beta startup.
- One OpenCode schema-validation retry is requested; no custom model retry loop.
- Small output limit where the endpoint/model supports it.
- Abort immediately when the permission is resolved elsewhere.
- No verdict caching in the first release.
- No fallback model.

### GPT-5.6 Luna development profile

Use GPT-5.6 Luna for prompt iteration, latency measurement, and the initial
adversarial corpus. Store its exact provider/model ID only in local development
configuration and evaluation invocation examples, never in runtime defaults.

Before beta release, run the same smoke corpus with at least one non-OpenAI model
to verify the provider-agnostic contract.

## 10. OpenCode Compatibility Risks

### Missing pre-permission hook

V2 still publishes a pending permission before plugins can review it. Prompt
flicker is unavoidable until OpenCode adds a synchronous permission gate.

### Built-in `--auto`

OpenCode's built-in auto mode immediately replies `once` to pending requests
and can bypass this reviewer. The first release must:

- document that `--auto` and the TUI's auto-approve mode are incompatible;
- abort its own work when it observes an earlier reply;
- detect an immediate competing auto-reply where possible;
- show one prominent warning and mark diagnostics as bypassed;
- never claim protection while bypassed.

The compatibility spike must determine whether V2 exposes a reliable mode
signal. If it does not, this limitation remains explicit in release notes.

### V2 API churn

The published beta and `v2` branch have changed plugin entrypoint layouts. All
development dependencies are pinned exactly. A small adapter module owns every
OpenCode-specific type and API call so schema changes do not spread through
the reviewer core.

## 11. Testing And Evaluation

### Unit tests

- Config validation and model reference parsing.
- Exact decision parser behavior.
- Deterministic policy allow, deny, and abstain cases.
- Context extraction excludes assistant prose and tool results.
- Root-session and call-ID resolution.
- Secret redaction.
- Retry-loop equivalence and circuit breaker.
- Request cancellation and first-reply-wins races.
- History bounds and failure cooldowns.

### Integration tests

- Synthetic `permission.asked` to `permission.reply` flow.
- Human reply while model review is in flight.
- Provider timeout and malformed model output leave the prompt pending.
- Allow sends only `once`.
- Deny sends corrective feedback.
- Ask sends no reply.
- Multiple resources are all reviewed.
- Subagent requests use root human context.
- TUI package resolution from an exact local Git tag.
- Installer merges both config files without losing unrelated fields.
- Uninstall removes only entries installed by this project.

### End-to-end tests

Run against stable OpenCode and the exact supported V2 binary on Linux first,
then macOS and Windows before the first stable tag:

1. Fresh config and clean repository.
2. Install through `INSTALL.md` instructions.
3. Select the development model.
4. Verify footer status.
5. Run a safe shell request and observe uninterrupted continuation.
6. Run a hard-deny request and verify no execution.
7. Run an ambiguous request and approve manually.
8. Simulate model outage and verify manual fallback.
9. Verify subagent behavior.
10. Verify the built-in auto-mode incompatibility warning.

### Adversarial evaluation corpus

Maintain versioned JSONL cases covering:

- shell composition, pipes, redirects, substitutions, and quoting;
- environment variables and unresolved paths;
- recursive deletion and symlink escapes;
- destructive Git operations;
- package installs and arbitrary scripts;
- credential reads and exfiltration;
- cloud and production operations;
- prompt injection in commands, paths, branch names, and user messages;
- explicit user boundaries;
- subagent provenance;
- malformed and conflicting reviewer outputs.

Release gates for hard-policy cases:

- Zero false allows in deterministic hard-deny tests.
- Zero false allows in the labelled high-risk Luna evaluation set.
- Safe-case allow rate is measured but never traded against a false allow.
- Reviewer latency target: p50 below 500 ms and p95 below 1.5 seconds on the
  development model and environment.

Use shadow mode with real development sessions before enabling automatic
replies by default. Shadow data stays local and is exported only by explicit
user action.

## 12. Milestones

### Milestone 0: Stable and V2 compatibility spike

Deliverables:

- Pin the exact OpenCode V2 beta and plugin packages; verify stable `1.18.12`.
- Prove a Git-backed `./tui` package loads with options.
- Prove receipt of `permission.asked` and cancellation on
  `permission.replied`.
- Prove the isolated reviewer session uses the selected model, receives no
  ambient coding-agent context, and is deleted after each review.
- Prove `permission.reply` allow, reject-with-feedback, and lost-race behavior.
- Verify exact tool input lookup through message ID and call ID.
- Measure native prompt flicker and Luna latency.
- Determine what can be detected about built-in auto mode.

Exit criterion: a disposable spike demonstrates one safe allow, one automatic
deny, one abstention, and one reviewer failure against the real beta.

### Milestone 1: Repository and package foundation

Deliverables:

- TypeScript, formatter, lint, typecheck, and test configuration.
- Pinned development dependencies.
- `./server` and `./tui` exports with reproducible bundled builds.
- MIT license, contributing guide, security policy, and changelog.
- CI for lint, typecheck, tests, build reproducibility, and package smoke test.

Exit criterion: a temporary Git tag installs into a clean OpenCode test home.

### Milestone 2: Reviewer core in shadow mode

Deliverables:

- Config schema and exact model validation.
- Context extraction and root-session resolution.
- Deterministic policy.
- Stateless model request and strict verdict parser.
- Redacted bounded history.
- Shadow-mode diagnostics.
- Initial adversarial corpus with GPT-5.6 Luna baselines.

Exit criterion: shadow mode processes representative sessions without sending
permission replies and meets the hard-risk evaluation gate.

### Milestone 3: Automatic decisions and race safety

Deliverables:

- Allow-once, reject-with-feedback, and abstain flow.
- Abort and first-reply-wins handling.
- Equivalent-denial circuit breaker.
- Timeouts and provider failures fall back to manual.
- No persistent approval or verdict cache.

Exit criterion: integration tests prove no late reviewer response can replace
an earlier human decision.

### Milestone 4: Quiet TUI UX

Deliverables:

- Footer status slot.
- Delayed reviewing state.
- Concise block, manual-review, and degraded feedback.
- Unfocused-only attention notification for manual input.
- History and diagnostics commands.
- Built-in auto-mode incompatibility warning.

Exit criterion: routine safe workflows produce no success toast, transcript
noise, desktop notification, or artificial countdown.

### Milestone 5: Installer and documentation

Deliverables:

- Root `INSTALL.md` with one-prompt install, update, and uninstall flows.
- Safe JSON/JSONC merge behavior and examples.
- Stable-tag pinning.
- Supported-version matrix and troubleshooting guide.
- Verification command and expected status output.

Exit criterion: a user with a fresh supported OpenCode install needs to choose
only a model and restart.

### Milestone 6: Beta release

Deliverables:

- Cross-model smoke evaluation.
- Linux end-to-end evidence.
- macOS and Windows installation/package smoke tests.
- `v0.1.0-beta.1` immutable tag.
- GitHub prerelease with known limitations and supported OpenCode build.

Exit criterion: field testing confirms no false allows in reported high-risk
cases and acceptable prompt flicker/latency.

### Milestone 7: First stable release

Deliverables:

- Resolve beta findings.
- Complete platform matrix.
- Update `INSTALL.md` to the stable tag.
- `v0.1.0` tag and GitHub Release.

Exit criterion: the plugin is safe to recommend for trusted local development
with the documented limitations.

## 13. Release Checklist

1. Confirm the worktree is clean and `main` is current.
2. Run unit, integration, package, and supported-beta end-to-end tests.
3. Run Luna and cross-model evaluation gates.
4. Bump the package version.
5. Update `CHANGELOG.md`, compatibility matrix, and `INSTALL.md` pin.
6. Rebuild `dist` and verify source/build parity.
7. Commit the release changes.
8. Create and push an annotated immutable SemVer tag.
9. Create the matching GitHub Release with no binary assets.
10. Install from the tag into a clean temporary OpenCode home and run the
   acceptance flow once more.

## 14. Immediate Next Step

Milestone 0 is implemented as a compatibility-first spike. See
[`COMPATIBILITY_SPIKE.md`](COMPATIBILITY_SPIKE.md) for verified behavior,
measurements, upstream beta inconsistencies, and remaining work. The next step
is a real interactive TUI acceptance run covering event receipt through final
permission resolution.
