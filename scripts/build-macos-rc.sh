#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="${1:?Usage: scripts/build-macos-rc.sh <artifact-directory>}"
artifact_dir="$(mkdir -p "$artifact_dir" && cd "$artifact_dir" && pwd)"
build_parent="${TMPDIR:-/tmp}"
staged_goose="$repo_root/ui/desktop/src/bin/goose"
source_goose="$repo_root/target/release/goose"
temporary_stage="${staged_goose}.rc6-tmp"
release_version="$(node -p "require('$repo_root/ui/desktop/package.json').version")"

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "This release build must run on native macOS arm64." >&2
  exit 2
fi
if [[ "$release_version" != 0.1.0-rc.6 ]]; then
  echo "Expected desktop version 0.1.0-rc.6, found $release_version." >&2
  exit 2
fi
if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
  echo "This script creates an ad-hoc signed internal preview; use the Developer ID release workflow for signed releases." >&2
  exit 2
fi
if [[ -e "$staged_goose" || -L "$staged_goose" || -e "$temporary_stage" ]]; then
  echo "Refusing to replace an existing desktop backend binary." >&2
  exit 2
fi

artifact="$artifact_dir/SayGM-${release_version}-darwin-arm64.zip"
if [[ -e "$artifact" ]]; then
  echo "Refusing to overwrite existing macOS RC6 artifact: $artifact" >&2
  exit 2
fi

mkdir -p "$artifact_dir" "$build_parent"
build_out="$(mktemp -d "$build_parent/saygm-macos-rc6-forge.XXXXXX")"
staged=false
source_hash=""
cleanup() {
  if [[ -n "$build_out" ]]; then rm -rf "$build_out"; fi
  if [[ "$staged" == true && -f "$staged_goose" ]]; then
    local current_hash
    current_hash="$(shasum -a 256 "$staged_goose" | cut -d ' ' -f 1)"
    if [[ "$current_hash" == "$source_hash" ]]; then
      rm -f "$staged_goose"
    else
      echo "Staged Goose changed during packaging; preserving it for inspection." >&2
      exit 1
    fi
  fi
  rm -f "$temporary_stage"
}
trap cleanup EXIT

cd "$repo_root"
cargo build --locked --release -p goose-cli --bin goose
test -x "$source_goose"
file "$source_goose" | grep -F arm64
"$source_goose" --version
source_hash="$(shasum -a 256 "$source_goose" | cut -d ' ' -f 1)"
install -m 0755 "$source_goose" "$temporary_stage"
mv "$temporary_stage" "$staged_goose"
staged=true
node "$repo_root/ui/desktop/scripts/prepare-platform-binaries.js"

pnpm --dir ui/desktop run build-goose-acp-client
pnpm --dir ui/desktop run i18n:compile
SAYGM_RELEASE_OUT_DIR="$build_out" ELECTRON_ARCH=arm64 pnpm --dir ui/desktop exec electron-forge make \
  --platform=darwin \
  --arch=arm64 \
  --targets=@electron-forge/maker-zip

app_path="$build_out/SayGM-darwin-arm64/SayGM.app"
backend_path="$app_path/Contents/Resources/bin/goose"
test -d "$app_path"
test -x "$backend_path"
if find "$app_path/Contents/Resources/bin" -type f \( -name '*.exe' -o -name '*.dll' -o -name '*.cmd' -o -name goosed \) -print -quit | grep -q .; then
  echo "Packaged resources contain a Windows or legacy Goose binary." >&2
  exit 1
fi
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist")" != com.saygm.desktop ]]; then
  echo "Packaged application bundle identifier is incorrect." >&2
  exit 1
fi
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Contents/Info.plist")" != "$release_version" ]]; then
  echo "Packaged application version is incorrect." >&2
  exit 1
fi
if [[ "$(shasum -a 256 "$backend_path" | cut -d ' ' -f 1)" != "$source_hash" ]]; then
  echo "Packaged backend differs from the Cargo release binary." >&2
  exit 1
fi

codesign --force --deep --sign - --entitlements "$repo_root/ui/desktop/entitlements.plist" "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$artifact"
shasum -a 256 "$artifact" > "$artifact.sha256"

echo "Built internal macOS artifact: $artifact"
