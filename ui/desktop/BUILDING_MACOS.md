# Building the internal macOS preview

From the repository root on an Apple Silicon Mac:

```sh
source bin/activate-hermit
pnpm --dir ui install --frozen-lockfile
scripts/build-macos-rc.sh ../saygm-desktop-beta3-artifacts
```

The script builds the Goose backend, packages it with SayGM Desktop, ad-hoc
signs and verifies the app bundle, and writes a ZIP plus SHA-256 file. This is
an internal, unnotarized preview; it is not a Developer ID release artifact.
