# SayGM Desktop release candidates

## 0.1.0-rc.6 (internal candidate)

- Integrate Goose upstream `main` at `fe55e842fb8d92f16c45d04c83f07120cc4fa258` while preserving SayGM identity, account policy, pinned backend TLS, and SayGM update behavior.
- Add an About page with a positive Goose attribution, a thank-you to the Goose team and community, and links to Goose and SayGM.com. The native About menu opens this page, including before onboarding.
- Point in-app ticket raising to the public SayGM Desktop issue forms.
- Update the Windows installer identity and RC6 platform build and verification metadata.
- Offer SayGM's Claude models, routed through the gateway's Messages API.

Desktop typecheck, lint, localization checks and 1,089 UI tests passed (8 skipped). Rust formatting and Clippy passed; all 2,498 Goose library tests passed. The ACP effort-update test now uses the secret-free Ollama inventory fixture, so it tests notification forwarding without consulting a local OpenAI credential store.

A macOS arm64 internal preview was built with Goose `1.55.0`. The packaged backend checksum matches the native release binary, the app bundle identifier and version were verified, and the extracted bundle passes strict ad-hoc signature verification. Artifact SHA-256: `380d4f70068d4d9f3f0b1b26bb7de2fff92f198416ccfbca07b81f3ba38535f0`.

This is an ad-hoc signed, unnotarized manual preview. In-app updates remain disabled, so it does not upgrade RC5 installs. Ubuntu and Windows packages have not been built or published, no GitHub artifacts have been uploaded, and the public RC5 artifacts remain unchanged.

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

This preview is being opened at the user's request before the final QA pass. Native startup, sign-in completion, and storage-prompt behavior require on-device verification; source and artifact checks alone do not establish those results. It remains ad hoc signed and unnotarized.

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
