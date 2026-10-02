# Windows x64 release build

The private `Build SayGM Desktop for Windows` workflow builds the Goose backend
from this source revision with the repository's pinned Rust toolchain, then
packages the Electron application on a native Windows x64 runner. It produces
an unsigned per-user installer and a portable ZIP. The workflow uploads them
as private GitHub Actions artifacts and does not publish a GitHub release.

The artifact includes the versioned installer, portable archive, SHA-256 sums,
and native smoke reports. The smoke install checks the per-user uninstall
record, launches the packaged renderer and local ACP backend with isolated
profile data, verifies disposable OS credential storage and Windows DPAPI, and
removes the test installation. It does not use customer credentials or make
model requests.

For an internal test install, run the installer and follow the per-user prompts.
To remove it, use **Settings → Apps → Installed apps → SayGM Desktop**, or run
`unins000.exe` from the installation directory. The portable ZIP contains the
packaged application directory and does not install shortcuts or register an
uninstaller.

These artifacts are unsigned internal test builds. Windows may display its
usual publisher warning. Verify an artifact with the adjacent
`SHA256SUMS.txt` file before use.
