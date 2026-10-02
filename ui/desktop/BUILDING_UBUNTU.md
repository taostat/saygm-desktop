# Building the Ubuntu RC5 package

The private Ubuntu workflow builds the Goose backend and desktop app on a native
Ubuntu 22.04 x86_64 runner. It creates an amd64 Debian package and a portable ZIP
for SayGM Desktop 0.1.0-rc.5. The workflow uploads a private Actions artifact; it
does not publish a public release.

For a local build, use Ubuntu 22.04 x86_64 with Rust 1.96.1, Node 24.10.0, and
pnpm 10.30.3. Install the native packages listed in
`.github/workflows/build-ubuntu.yml`, then run:

```bash
pnpm --dir ui install --frozen-lockfile
scripts/build-ubuntu-release.sh ./artifacts
```

The build compiles `goose-cli` from the checked out source, stages its binary
temporarily while Forge packages the app, and removes only the staged file after
checking that it has not changed. It verifies that the packaged backend matches
the Cargo build and that the Debian launcher, desktop entry, runtime libraries,
ASAR file list, and architecture are correct.

Install the Debian package with:

```bash
sudo apt install ./artifacts/SayGM-0.1.0-rc.5-linux-x64.deb
```

Linux credentials require an unlocked Secret Service provider such as GNOME
Keyring. Start the provider and unlock its keyring before signing in. SayGM
refuses OAuth setup when secure credential storage is unavailable; basic_text
storage is not accepted for account credentials. A usable session-level keyring
is required.

The artifact uses production SayGM API and gateway endpoints. The RC5 native QA
harness starts the installed app with an isolated profile, verifies the bundled
backend ACP handshake, and tests credential storage using a disposable
non-authoritative fixture. It does not log into an account, use customer keys,
or submit inference requests.
