# Contributing to opencode-auto-permissions

## Setup

```bash
git clone https://github.com/hueyexe/opencode-auto-permissions.git
cd opencode-auto-permissions
bun install
```

Development requires [Bun](https://bun.sh/) and Node.js 22 or later.

## Development Workflow

This project follows TDD (Red/Green/Refactor):

1. Write the test first in `test/`. It must fail for the right reason.
2. Write the minimum implementation in `src/` to make it pass.
3. Refactor without changing behavior. Confirm tests still pass.

Before submitting any change:

```bash
bun run verify
```

`verify` runs strict TypeScript checks, the test suite, a production build, and
package export smoke tests. Isolated runtime launchers (`bun run test:stable`,
`bun run test:v2`) start a real OpenCode server in an isolated environment; see
[Testing](docs/TESTING.md).

## Branch Naming (required)

CI enforces a branch-name prefix on every PR via the `branch-name` check. Your
PR's head branch **must** start with one of:

- `feature/` — new functionality (e.g. `feature/session-approvals`)
- `bugfix/` — fixes (e.g. `bugfix/reply-timeout`)
- `chore/` — tooling, docs, deps, refactors (e.g. `chore/update-deps`)

> **Common gotcha:** opening a PR directly from your fork's `main` branch fails
> this check, because `main` has no valid prefix. Always create a prefixed
> branch before pushing:
>
> ```bash
> git checkout -b bugfix/short-description
> ```
>
> If you already committed to `main` on your fork, move the work to a prefixed
> branch and open the PR from there.

## Submitting Changes

1. Fork the repo and create a branch off `main` using a `bugfix/`, `feature/`,
   or `chore/` prefix (see above)
2. Make your changes following TDD and the code standards below
3. Run `bun run verify` — it must pass
4. Open a PR against `main`
5. The `check` CI status must pass on your PR (the `branch-name` check must
   pass too)
6. A maintainer (@hueyexe) will review and merge

All PRs require at least one approval from a code owner before merging. Direct
pushes to `main` are not allowed.

## Code Standards

- TypeScript strict mode
- Early returns over `else`; functional array methods over loops
- Deterministic policy rules resolve before any model review; the model only
  sees requests the policy cannot decide
- Fail closed: reviewer errors and timeouts reject the request
- Keep reviewer context minimal and privacy-preserving; never log commands,
  paths, tool inputs, or conversation text
- New protocol paths (stable and V2) must be covered by tests in `test/`

## Testing

- `bun test` is the only test runner; tests in `test/` mirror `src/` modules
- `installReviewer` is exercised with injected clients in `test/reviewer.test.ts`;
  no network or real OpenCode processes are required for unit tests
- The runtime launchers in `scripts/test-runtime.ts` validate against real
  OpenCode stable and V2 builds in isolated XDG directories

## Project Structure

```
src/
├── server.ts            # Stable server plugin entry point
├── tui.ts               # V2 TUI plugin entry point
├── reviewer.ts          # Permission review pipeline (ask/reply/timeout)
├── context.ts           # Event normalization and review context collection
├── policy.ts            # Deterministic safety rules
├── prompt.ts            # Reviewer prompt construction
├── verdict.ts           # Reviewer output parsing
├── stable.ts            # Stable runtime adapter
├── opencode-client.ts   # Session creation and permission reply adapter
├── config.ts            # Plugin options parsing
├── diagnostics.ts       # Bounded JSONL diagnostics
├── agent.ts             # Hidden reviewer agent definition
└── types.ts             # Shared types

test/                    # Unit tests mirroring src/
scripts/test-runtime.ts  # Isolated stable/V2 runtime launchers
docs/                    # Build plan, compatibility notes, testing guide
```

## Releases

Releases are cut from `main` by maintainers. Version tags follow `vX.Y.Z` and
the npm package is published from the tagged commit.