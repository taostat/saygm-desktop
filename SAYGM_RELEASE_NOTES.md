# SayGM Desktop release candidates

## Unreleased — upstream maintenance

- Restore the original Goose ancestry while preserving existing private commits and releases.
- Add an isolated, pinned upstream-update workflow and document the downstream integration boundaries.
- Reconcile the reviewed Windows and Ubuntu sources into one maintenance branch.
- Centralise desktop product configuration and separate SayGM styles from the shared stylesheet.
- Centralise backend prompt identity and desktop storage policy while retaining existing behaviour.

These are source changes. Existing RC5 downloads are unchanged; adopting a newer Goose revision and publishing new platform packages remain separate steps.

## 0.1.0-rc.5 (internal Apple Silicon preview)

- Refresh guardrail capability and availability messaging in the desktop editor.
- Preserve existing saved scanner configuration while previewing supported scanner settings.
- Improve the saved-state message and layout across narrow and wide windows.

This candidate remains ad hoc signed and unnotarized. It is an internal preview, not a Developer ID installer.

## 0.1.0-rc.4 (provisional preview)

- Preserve refreshed account credentials through managed model-key cleanup and avoid clearing the same local key twice.
- Correct the model-selection path for the SayGM HTTP API provider.
- Display USD balances with two decimal places while preserving internal precision.

Focused protocol, display and type checks passed. This preview is being opened before the final QA pass at the user's request. On-device model selection and inference have not yet been verified. It remains ad hoc signed and unnotarized.

## 0.1.0-rc.3 (provisional preview)

- Correct first-time credential saving when the SayGM keyring item is absent, preserving fail-closed behavior for storage failures.
- Report specific, safe credential-storage errors during model setup.
- Separate the renderer connection-open deadline from backend protocol initialization.
- Retry pending cleanup for the current session's managed model key before creating a replacement.
- Make the account panel scroll within short windows.
- Replace manual balance refresh with automatic updates on entry and focus, with request coalescing and failure backoff.
- Preserve the menu-bar logo's proportions and add transparent vertical margins.

This preview is being opened at the user's request before final QA. Native startup, sign-in completion, and storage-prompt behavior require on-device verification; source and artifact checks alone do not establish those results. It remains ad hoc signed and unnotarized.

## 0.1.0-rc.2

Startup repair for the internal macOS Apple Silicon candidate:

- Check local backend readiness over a certificate-pinned Node HTTPS connection, independent of Chromium's credential-store initialization.
- Defer Chromium certificate-verifier initialization until backend readiness, while retaining verification before renderer loading.
- Record sanitized readiness failure details.

Existing keychain items are preserved. macOS may still request authorization for the packaged app to use an item created by the development build. This candidate remains ad hoc signed and unnotarized; successful automated checks do not establish final on-device storage behavior.

## 0.1.0-rc.1

Internal macOS Apple Silicon release candidate.

## Included

- SayGM branding and the approved desktop design, with bundled fonts.
- SayGM model selection, browser sign-in, API-key connection, balances and browser top-ups.
- Native guardrail settings and draft previews, with automatic refresh that preserves unsaved edits.
- Separate local tool approvals and isolated SayGM application storage.
- Responsive onboarding with a 1200 by 800 default window, capped to the screen.
- Background secure-storage failure handling that avoids repeated automatic checks after a failure.

## Validation

- 1,025 desktop tests, typecheck, lint, localization checks and renderer build passed.
- Focused storage, provider catalog and cancellation checks passed.
- Responsive onboarding checked at 480, 940, 1005 and 1200 pixels wide.
- Application and archive contents, checksums, ad hoc signatures and bundled licenses verified.
- Production accepts the SayGM Desktop OAuth client identifier.

## Candidate limitations

- Ad hoc signed; not Developer ID signed or notarized. Intended for internal evaluation.
- Final packaged startup and macOS secure-storage prompt behavior have not been retested after the last storage fix.
- Live sign-in completion and inference have not been verified.
- Scoped guardrail account APIs and compatible gateway/registry deployment remain release dependencies.
- No public release or automatic-update feed has been published.
