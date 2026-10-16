# Maintenance validation

## RC6 candidate validation — 2026-10-16

Candidate commit `544291d67411fe68cc0197812f4785f3efbfb014` merges Goose
`main` at `fe55e842fb8d92f16c45d04c83f07120cc4fa258` and includes the About
page, ticket-link update, and RC6 packaging metadata.

- `cargo fmt` passed. `cargo clippy --all-targets -- -D warnings` passed.
- `cargo test -p goose --lib --features
  portable-default,system-keyring,code-mode,local-inference,online-model-meta`
  passed all 2,498 tests. The ACP effort-update test now uses the secret-free
  Ollama inventory fixture; the previous OpenAI fixture read the global
  credential store and made that notification test environment-dependent.
- `pnpm --dir ui/desktop run lint:check` passed TypeScript, ESLint, and locale
  validation (1,612 messages across 15 locales).
- `pnpm --dir ui/desktop run test:run` passed: 122 files, 1,089 tests; 1 file
  and 8 tests skipped.
- The macOS arm64 internal preview is at
  `/Users/mark/Contracts/saygm-desktop-rc6-final-artifacts/SayGM-0.1.0-rc.6-darwin-arm64.zip`.
  SHA-256: `380d4f70068d4d9f3f0b1b26bb7de2fff92f198416ccfbca07b81f3ba38535f0`.
  Its embedded Goose `1.55.0` binary matches the native release binary; the
  extracted app passes strict ad-hoc signature verification and has bundle ID
  `com.saygm.desktop` and version `0.1.0-rc.6`. The ZIP contains no Windows or
  legacy Goose binaries.
- Astra's read-only follow-up confirms the prior code and packaging findings
  are resolved and found no new provider, account, or TLS policy regression.
- Ubuntu and Windows packages have not been built. No GitHub artifacts or
  release have been published. `UPDATES_ENABLED` remains false, so this manual
  macOS preview cannot upgrade RC5 installs. The configured `origin` is public;
  the private release destination still needs to be identified.

This is a verified macOS internal preview, not a completed multi-platform or
published RC6 release.

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
