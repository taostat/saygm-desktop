# SayGM Desktop

SayGM Desktop is the SayGM client built on Goose, with browser OAuth sign-in, account balance, model selection, and customer guardrail controls.

This private repository contains the reviewed RC5 source and platform release automation. The original upstream license and notices are retained. See [source provenance](SAYGM_BUILD_PROVENANCE.md) and the [upstream README](UPSTREAM_README.md).

## Internal releases

Current version: `0.1.0-rc.5`.

- macOS Apple Silicon: internal ZIP and DMG; ad hoc signed and not notarized.
- Ubuntu x64: native backend and Debian package build is being added.
- Windows x64: native backend, portable package, and installer build is being added.

The Windows and Ubuntu artifacts must pass their native build and package checks before being marked ready. macOS Developer ID signing and notarization remain pending certificate setup.

## Development

Activate the pinned toolchain with `source bin/activate-hermit`. The desktop uses Node 24.10 and pnpm 10.30.3.

```sh
cd ui
pnpm install --frozen-lockfile
cd desktop
pnpm run typecheck
pnpm test:run
```

The backend lives in `crates/`; the desktop lives in `ui/desktop/`. The local environment, credential stores, ignored binaries, build outputs, and design drafts are excluded from the imported source snapshot.

Production account API: `https://account.saygm.com/v1`.
Inference API: `https://api.saygm.com/v1`.

Keep internal artifacts and signing credentials in private storage. Release workflows upload internal build artifacts; they do not publish to the public Goose repository.
