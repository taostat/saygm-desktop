# Maintenance validation — 2026-10-05

Runtime source reviewed at `aaa6a16f71c3914e9345d9bc8f123b2f081be63d`.
Later documentation changes do not alter that source. Implementation used Luna
developers with independent Astra review.

## Results

- Full desktop suite: 122 files, 1,093 tests passed; desktop typecheck and production
  renderer build passed on pinned Node 24.10.0 / pnpm 10.30.3.
- Frontend focused regression suite: 74 passed. Independent compiled CSS comparison
  preserved authored selectors, declarations and order, 81 property registrations,
  18 unique keyframes, all 80 fonts and 81 CSS asset URLs.
- Goose prompt tests: 6 passed; local-inference prompt tests: 2 passed. Independent
  prompt parity fixtures: 56 passed, including map collisions and non-map contexts.
- Desktop policy tests: 2 passed; captured/current-policy test passed with and
  without `system-keyring`; 6 in-memory keyring regressions passed. Independent
  policy fixtures: 5 passed.
- PromptManager: 16 passed. The feature-dependent platform-extension snapshot was
  excluded; this does not represent an all-feature platform build.
- `cargo fmt --all -- --check` passed. All-targets clippy with `-D warnings` passed
  for `goose` (features `scheduler,system-keyring,acp-http`) and
  `goose-local-inference`.
- Update-tool fixtures: 18 passed, including successful/conflicting merges, invalid
  inputs, dirty checkouts, nested/symlink destinations and concurrent source changes.
- The ancestry bridge kept an identical source tree. Existing private history,
  repository visibility, RC5 tag and release assets were preserved.

## Upstream rehearsal

Pinned candidate: `d7ce0cdf8c4e1fb55aabed5b6717f141c4c8220f`, 14 commits after
the incorporated `bab8ff6` base. Both the unified pre-refactor baseline and the final
source report the same two text conflicts: the removed MCP workflow and the Windows
wrapper README. The refactor adds no text conflicts in this sample; this is not a
claim that future updates will merge automatically.

A separate worktree resolves those conflicts and adapts the new Windows wrapper
tests to SayGM-owned temporary paths. Its UI typecheck, renderer build and 27 updater
tests passed. Nine Windows-only tests require native Windows execution before that
upstream candidate is adopted. The maintenance branch continues to pin `bab8ff6`.

No new installer was published by this maintenance change. New upstream behavior
and new native releases require their own validation.
