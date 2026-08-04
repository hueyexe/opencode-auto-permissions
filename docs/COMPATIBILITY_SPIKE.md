# OpenCode V2 Compatibility Spike

Verified on 4 August 2026 against:

- OpenCode `0.0.0-beta-202608040144`
- `@opencode-ai/plugin@0.0.0-beta-202608040144`
- `@opencode-ai/sdk@0.0.0-beta-202608040144`
- Reviewer model `kiro/gpt-5.6-luna`

## Proven

- A Git package can expose separate `./server` and `./tui` entrypoints.
- The transitional beta server loader accepts the legacy `{ server() }` module
  envelope; the package also exports the newer `id/setup` shape.
- The server plugin registers a hidden reviewer agent with wildcard-deny
  permissions and no ordinary tools.
- Permission events use `permission.v2.asked` and
  `permission.v2.replied` with action, resources, and tool provenance.
- V2 session-scoped permission replies work. A live smoke test moved from one
  pending permission to zero.
- Luna returns a decision through OpenCode's `json_schema` structured-output
  contract. The plugin accepts only `info.structured` and never parses fallback
  text.
- The synthetic `StructuredOutput` tool is the only capability re-allowed over
  the reviewer's wildcard deny.
- Reviewer sessions run in an isolated temporary location and are deleted in
  `finally`. Live smoke tests left zero child sessions.
- Human/other-client replies cancel in-flight reviews, and late replies treat
  `404` as a benign lost race.
- Deterministic policy handles routine local commands and hard-risk categories
  before model review.

## Measurements

The first implementation inherited the normal coding-agent context:

- approximately 8,100 input tokens per review;
- approximately 2.6 seconds warm latency;
- approximately 6 seconds including cold location startup.

Reviewer-only system isolation reduced the warm request to:

- 1,594 input tokens;
- 59 output tokens;
- approximately 2.0 seconds model latency.

Cold end-to-end review remains approximately 6 seconds in this beta because
location services and globally discovered skills initialize before the first
request. The plugin now performs best-effort, no-model prewarming and uses an
eight-second timeout. Further latency work is required before claiming the
target sub-1.5-second P95 UX.

## Beta Inconsistencies Handled

- The published plugin declarations and runtime loader use different plugin
  module generations. The package exports both supported shapes.
- `/api/generate` and session transient-generation routes appear in nearby V2
  source but are not registered in this binary. The spike uses an isolated
  legacy session prompt instead.
- `session.wait` is present but returns `503` in this binary.
- Agent wildcard permission keys work through the runtime schema but are
  missing from generated TypeScript declarations.
- `retryCount` is accepted in the structured-output request, but this beta
  reports structured-output failures with `retries: 0`. The plugin fails to
  manual approval rather than parsing malformed model text.

## Remaining Milestone 0 Gap

The model lifecycle and permission reply lifecycle have each passed against the
real beta server. The packaged TUI entrypoint imports successfully and its
event/race behavior is covered by tests, but a complete interactive run from a
real TUI-generated permission event through automatic review and resolution is
still required before a prerelease tag.
