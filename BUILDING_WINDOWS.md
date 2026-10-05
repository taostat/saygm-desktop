# Windows x64 release build

The private `Build SayGM Desktop for Windows` workflow builds the Goose backend
from this source revision with the repository's pinned Rust toolchain, then
packages the Electron application on a native Windows x64 runner. It produces
an unsigned per-user installer and a portable ZIP. The workflow uploads them
as private GitHub Actions artifacts and does not publish a GitHub release.
The x64 Microsoft Visual C++ runtime DLLs imported by Goose are copied from the
Visual Studio redistributable files beside the backend. This lets the portable
bundle run without a machine-wide Visual C++ runtime installation; the bundled
runtime files are covered by the artifact checksums and should be refreshed by
building again with the pinned workflow when the toolchain is updated.

The artifact includes the versioned installer, portable archive, SHA-256 sums,
the native executable and DLL dependency report, and smoke reports. The smoke
install checks the per-user uninstall record, launches the packaged renderer
and local ACP backend with isolated profile data, verifies disposable OS
credential storage and Windows DPAPI, records the installed `saygm` protocol
command, and removes that handler on uninstall only when it points to this
installation. It does not use customer credentials or submit inference
requests.

For an internal test install, run the installer and follow the per-user prompts.
To remove it, use **Settings → Apps → Installed apps → SayGM Desktop**, or run
`unins000.exe` from the installation directory. The portable ZIP contains the
packaged application directory and does not install shortcuts or register an
uninstaller.

These artifacts are unsigned internal test builds. Windows may display its
usual publisher warning. Verify an artifact with the adjacent
`SHA256SUMS.txt` file before use.
