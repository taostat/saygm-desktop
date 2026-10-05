# Maintaining the Goose downstream

SayGM uses Goose's Rust workspace, provider interface, ACP connection, and Electron
desktop. Keep new product behavior in dedicated modules and make the integration
points in inherited code small. A clean textual merge does not prove compatibility.

## History and provenance

`upstream.json` records the exact incorporated upstream revision. The initial
private repository was imported as snapshot `b063eaf`, including downstream
changes from the original checkout at `3a86cdf`. That checkout's Goose base was
`bab8ff641039c9cd3331121cd84a5c6045f365ca`; `3a86cdf` is a downstream commit,
not an upstream release.

The maintenance branch adds a one-time ancestry bridge to that historical base.
The bridge uses Git's `ours` merge strategy solely to retain the already imported
tree while attaching the missing parent history. Existing commits and release
tags are preserved. Never use that strategy, or blanket conflict preference,
for a subsequent upstream update: it would silently discard upstream changes.

## Prepare an update

Use the private SayGM repository as `origin`. Configure Goose as a fetch-only
remote once, then fetch it before choosing an immutable commit:

```sh
git remote add upstream https://github.com/aaif-goose/goose.git
git remote set-url --push upstream DISABLED
git fetch upstream main
git rev-parse upstream/main
```

From a clean SayGM checkout, substitute that full SHA and a new directory/branch:

```sh
python3 scripts/upstream-sync.py FULL_UPSTREAM_SHA ../saygm-upstream-review \
  --branch maintenance/goose-update
```

The command prepares an ordinary, uncommitted merge in the new worktree and
prints a JSON conflict inventory. It does not modify the source checkout, resolve
conflicts, update the incorporated revision, push, or publish. A nonzero exit with
conflicts is expected: resolve them in the new worktree. To discard a rehearsal,
run `git merge --abort` there; retain the report before removing the worktree.

## Review and acceptance

1. Read the upstream changes since `integrated_revision`, including migrations,
   dependencies, tool permissions, authentication, and both agent-loop paths.
2. Resolve conflicts by preserving the intended behavior on both sides. Inspect
   inherited `.github/workflows` even when Git merges them cleanly; SayGM uses
   private release automation and must not gain upstream publishing jobs.
3. Check SayGM provider-only enforcement, live model filtering, OAuth account
   lifecycle, secure credential storage, local backend TLS, approval mode, and
   account guardrail contracts. Keep tool IDs and `GOOSE_*` compatibility names.
4. Run focused Rust tests and clippy for touched crates; run desktop typecheck,
   lint and relevant regression tests. Build affected native backends and desktop
   packages. Exercise onboarding, chat/tool approvals and account/guardrails in
   isolated profiles; never use customer credentials for automated checks.
5. Obtain independent Astra review of the integrated source and artifact evidence.
   Record any unavailable platform checks explicitly. A source review alone does
   not certify new native packages.
6. Update `integrated_revision` to the merged upstream SHA, record evidence and
   release notes, and commit the merge. Open a private SayGM PR for review. Keep
   release publication separate from preparing the update.

## Keep the downstream patch small

- Add provider implementations through the existing `Provider` interface.
- Put product identity, URLs, theme and policy defaults in SayGM modules rather
  than copying literals into inherited components or runtime paths.
- Preserve upstream prompt instructions; supply product identity through a narrow
  rendering boundary. Preserve user-authored prompt overrides.
- Keep OAuth/account and guardrail operations in their existing service/IPC layer.
- Keep storage and transport security behavior explicit and tested. Extract policy
  decisions without rewriting the underlying mechanisms merely for uniformity.
- Propose generally useful fixes upstream separately, following its contribution
  process. Keep product-specific choices downstream.

Expected recurring review areas are provider registration, config/secret storage,
ACP startup, Electron main/preload, onboarding/navigation, and prompt rendering.
These integration points cannot all be eliminated by moving files.
